// Build the browser's view of a store from its raw records. Unknown fields and kinds pass through as JSON, so a
// newer pi-durable shows up with less structure rather than not at all.

import { applyOps } from "./store/ops.ts";
import type { Json, JsonObject, RawDocument, RawStore } from "./store/types.ts";
import type { Lens, LensConversation, LensDocument, LensEntry, LensSubmission, LensTask, LensUsage } from "./web/lens.ts";

/** pi-durable's default `settings.restartLimit` (1.4.0). */
export const DEFAULT_RESTART_LIMIT = 5;
const MAX_STATES = 500;

export type BuildOptions = {
	readonly restartLimit?: number;
	readonly readMs?: number;
	readonly decoder?: string;
	readonly displayPath?: string;
};

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export function emptyUsage(): LensUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

/** A pi-ai `Usage` (cost an object with `total`) as flat counters. */
function toUsage(value: unknown): LensUsage | undefined {
	if (!isObject(value)) return undefined;
	const cost = isObject(value.cost) ? num(value.cost.total) : num(value.cost);
	const usage = {
		input: num(value.input) ?? 0,
		output: num(value.output) ?? 0,
		cacheRead: num(value.cacheRead) ?? 0,
		cacheWrite: num(value.cacheWrite) ?? 0,
		totalTokens: num(value.totalTokens) ?? 0,
		cost: cost ?? 0,
	};
	if (usage.totalTokens === 0) usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return usage;
}

function addUsage(total: LensUsage, usage: LensUsage | undefined): void {
	if (usage === undefined) return;
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	total.cost += usage.cost;
}

function entryOf(raw: { record: JsonObject; seq: number | undefined }): LensEntry {
	const record = raw.record;
	const messages = Array.isArray(record.model) ? record.model : [];
	const entry: LensEntry = {
		id: Number(record.id),
		conversationId: Number(record.conversationId),
		kind: str(record.kind) ?? "?",
		messages,
	};
	if (raw.seq !== undefined) entry.seq = raw.seq;
	if (record.data !== undefined) entry.data = record.data;
	if (num(record.byTaskId) !== undefined) entry.byTaskId = Number(record.byTaskId);
	if (num(record.head) !== undefined) entry.head = Number(record.head);
	if (record.edits !== undefined) entry.edits = record.edits;
	for (const message of messages) {
		if (!isObject(message)) continue;
		entry.at ??= num(message.timestamp);
		if (num(message.durationMs) !== undefined) entry.durationMs = (entry.durationMs ?? 0) + Number(message.durationMs);
		if (message.role === "assistant") {
			const usage = toUsage(message.usage);
			if (usage !== undefined) {
				entry.usage ??= emptyUsage();
				addUsage(entry.usage, usage);
			}
			if (str(message.provider) !== undefined && str(message.model) !== undefined) entry.model = `${message.provider}/${message.model}`;
			if (str(message.stopReason) !== undefined) entry.stopReason = String(message.stopReason);
			if (str(message.errorMessage) !== undefined) entry.errorMessage = String(message.errorMessage);
		}
	}
	return entry;
}

function taskOf(record: JsonObject, restartLimit: number): LensTask {
	const state = isObject(record.state) ? record.state : {};
	const status = str(state.status) ?? "?";
	const restarts = num(record.restarts);
	const task: LensTask = {
		id: Number(record.id),
		kind: str(record.kind) ?? "?",
		conversationId: Number(record.conversationId),
		children: [],
		status,
		background: record.background === true,
		abortRequested: record.abortRequested === true,
		// A record is parked while it can run but crashed `restartLimit` times in a row; terminal ones are past it.
		parked: restarts !== undefined && restarts >= restartLimit && (status === "pending" || status === "running"),
	};
	if (num(record.version) !== undefined) task.version = Number(record.version);
	if (num(record.owner) !== undefined) task.owner = Number(record.owner);
	if (str(record.abortReason) !== undefined) task.abortReason = String(record.abortReason);
	if (num(record.startedAt) !== undefined) task.startedAt = Number(record.startedAt);
	if (num(record.endedAt) !== undefined) task.endedAt = Number(record.endedAt);
	if (restarts !== undefined) task.restarts = restarts;
	if (record.input !== undefined) task.input = record.input;
	if (record.memos !== undefined) task.memos = record.memos;
	if (state.checkpoint !== undefined) {
		task.checkpoint = state.checkpoint;
		if (isObject(state.checkpoint) && str(state.checkpoint.phase) !== undefined) task.phase = String(state.checkpoint.phase);
	}
	if (num(state.until) !== undefined) task.until = Number(state.until);
	if (Array.isArray(state.on)) task.on = state.on.map(Number);
	if (str(state.policy) !== undefined) task.policy = String(state.policy);
	if (isObject(state.outcome)) {
		const outcome = state.outcome;
		task.outcome = { status: str(outcome.status) ?? "?" };
		if (outcome.error !== undefined) task.outcome.error = outcome.error;
		if (str(outcome.reason) !== undefined) task.outcome.reason = String(outcome.reason);
		if (outcome.result !== undefined) task.outcome.result = outcome.result;
		if (isObject(outcome.result) && num(outcome.result.entryId) !== undefined) task.entryId = Number(outcome.result.entryId);
	}
	// Tool tasks name their call: `{ kind: "model", assistant, callId }` from 1.2.0, `{ assistant, callId }` before.
	if (task.kind === "pi.tool" && isObject(record.input)) {
		if (num(record.input.assistant) !== undefined) task.callEntryId = Number(record.input.assistant);
		if (str(record.input.callId) !== undefined) task.callId = String(record.input.callId);
		if (str(record.input.name) !== undefined) task.label = String(record.input.name);
	}
	return task;
}

/** Materialize a document from its revisions: the newest base, then the deltas after it. */
function documentOf(raw: RawDocument): LensDocument {
	const record = raw.record;
	const scope = isObject(record.scope) ? record.scope : {};
	const document: LensDocument = {
		id: Number(record.id),
		kind: str(record.kind) ?? "?",
		scope: { kind: str(scope.kind) ?? "?" },
		value: null,
		revisions: raw.revisions.map(({ seq, kind, version }) => ({ seq, kind, version })),
	};
	if (num(scope.conversationId) !== undefined) document.scope.conversationId = Number(scope.conversationId);
	if (num(scope.taskId) !== undefined) document.scope.taskId = Number(scope.taskId);
	if (str(record.key) !== undefined) document.key = String(record.key);
	if (num(record.createdAt) !== undefined) document.createdAt = Number(record.createdAt);
	if (num(record.retiredAt) !== undefined) document.retiredAt = Number(record.retiredAt);
	if (str(record.history) !== undefined) document.history = String(record.history);
	if (str(record.fork) !== undefined) document.fork = String(record.fork);

	const rewindable = document.history === "rewindable";
	const states: { seq: number; value: Json }[] = [];
	let value: Json | undefined;
	try {
		for (const revision of raw.revisions) {
			if (revision.kind === "base") value = structuredClone(revision.content);
			else if (value === undefined) continue; // deltas before the first base the store kept
			else value = applyOps(value, revision.content);
			document.version = revision.version;
			if (rewindable) states.push({ seq: revision.seq, value: structuredClone(value) });
		}
		document.value = value ?? null;
		if (value === undefined && raw.revisions.length > 0) document.error = "no base revision";
	} catch (error) {
		document.error = `could not apply revision: ${(error as Error).message}`;
		document.value = value ?? null;
	}
	if (rewindable) document.states = states.slice(-MAX_STATES);
	return document;
}

function submissionOf(record: JsonObject): LensSubmission {
	const submission: LensSubmission = {
		id: Number(record.id),
		conversationId: Number(record.conversationId),
		type: str(record.type) ?? "?",
		status: str(record.status) ?? "?",
	};
	if (num(record.entry) !== undefined) submission.entry = Number(record.entry);
	if (num(record.answer) !== undefined) submission.answer = Number(record.answer);
	if (str(record.reason) !== undefined) submission.reason = String(record.reason);
	if (str(record.requestId) !== undefined) submission.requestId = String(record.requestId);
	return submission;
}

/** The release range that could have written the store, from the schema version and the record shapes seen. */
function detectVersion(raw: RawStore, tasks: LensTask[], entries: LensEntry[]): { version: string; hints: string[] } {
	const hints: string[] = [];
	let floor = "1.0.0";
	let ceiling: string | undefined;
	const raise = (version: string, hint: string) => {
		hints.push(hint);
		if (compare(version, floor) > 0) floor = version;
	};
	if (raw.kind === "sqlite") {
		if (raw.schemaVersion === 1) {
			ceiling = "1.3";
			hints.push("SQLite schema v1: written by 1.3.0 or earlier, and not opened by 1.4.0 since (it would migrate to v2)");
		} else if (raw.schemaVersion === 2) {
			raise("1.4.0", "SQLite schema v2: 1.4.0 or later");
		} else {
			hints.push(`SQLite schema v${raw.schemaVersion ?? "?"}: newer than this durable-lens knows; showing what it can read`);
		}
		if (raw.prefix !== undefined) raise("1.3.0", `table prefix "${raw.prefix}": 1.3.0 or later`);
	} else {
		hints.push("JSONL format 1 (unchanged from 1.0.0 to main)");
	}
	if (tasks.some((task) => task.status === "sleeping")) raise("1.4.0", "sleeping tasks: 1.4.0 or later");
	if (tasks.some((task) => task.restarts !== undefined)) raise("1.4.0", "task restart counts: 1.4.0 or later");
	if (tasks.some((task) => task.kind === "pi.tool" && task.version === 2)) raise("1.2.0", "tool tasks version 2: 1.2.0 or later");
	if (tasks.some((task) => task.startedAt !== undefined)) raise("1.1.0", "task start and end times: 1.1.0 or later");
	if (entries.some((entry) => entry.kind === "pi.tool-result" && entry.durationMs !== undefined)) {
		raise("1.1.0", "tool result durations: 1.1.0 or later");
	}
	const low = floor.replace(/\.0$/, "");
	const version = ceiling === undefined ? `pi-durable ${low} or later` : low === ceiling ? `pi-durable ${low}` : `pi-durable ${low}–${ceiling}`;
	return { version, hints };
}

function compare(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function modelName(value: unknown): string | undefined {
	if (!isObject(value)) return undefined;
	const model = isObject(value.model) ? value.model : undefined;
	if (model === undefined) return undefined;
	const provider = str(model.provider);
	const id = str(model.modelId) ?? str(model.id);
	return provider !== undefined && id !== undefined ? `${provider}/${id}` : undefined;
}

function firstText(entry: LensEntry): string | undefined {
	for (const message of entry.messages) {
		if (!isObject(message)) continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			for (const part of message.content) if (isObject(part) && part.type === "text" && typeof part.text === "string") return part.text;
		}
	}
	return undefined;
}

export function buildLens(raw: RawStore, options: BuildOptions = {}): Lens {
	const restartLimit = options.restartLimit ?? DEFAULT_RESTART_LIMIT;
	const warnings = [...raw.warnings];
	// Records without their own id are not pi-durable JSON as stored in the clear.
	const opaque = [...raw.conversations, ...raw.entries.map((entry) => entry.record), ...raw.tasks].filter((record) => num(record.id) === undefined).length;
	if (opaque > 0) {
		warnings.push(`${opaque} records have no id: the adapter may encrypt or compress payloads at rest; pass --decoder with a module that decodes them`);
	}
	const entries = raw.entries.filter((entry) => num(entry.record.id) !== undefined).map(entryOf);
	const tasks = raw.tasks.filter((record) => num(record.id) !== undefined).map((record) => taskOf(record, restartLimit));
	const documents = raw.documents.filter((document) => num(document.record.id) !== undefined).map(documentOf);
	const submissions = raw.submissions.filter((record) => num(record.id) !== undefined).map(submissionOf);

	const taskById = new Map(tasks.map((task) => [task.id, task]));
	const entryById = new Map(entries.map((entry) => [entry.id, entry]));
	for (const task of tasks) {
		if (task.owner !== undefined) taskById.get(task.owner)?.children.push(task.id);
		if (task.kind === "pi.tool" && task.label === undefined && task.callEntryId !== undefined) {
			for (const message of entryById.get(task.callEntryId)?.messages ?? []) {
				if (!isObject(message) || !Array.isArray(message.content)) continue;
				for (const part of message.content) {
					if (isObject(part) && part.type === "toolCall" && part.id === task.callId && typeof part.name === "string") task.label = part.name;
				}
			}
		}
		if (task.kind === "pi.tool" && task.entryId === undefined && isObject(task.outcome?.result) && num(task.outcome.result.entryId) !== undefined) {
			task.entryId = Number(task.outcome.result.entryId);
		}
	}
	for (const task of tasks) {
		if (task.kind === "pi.generation" && task.entryId !== undefined) task.label = entryById.get(task.entryId)?.model;
	}

	// Entries without a message timestamp take their task's time, or the previous entry's.
	let previous: number | undefined;
	for (const entry of entries) {
		if (entry.at === undefined) {
			const task = entry.byTaskId === undefined ? undefined : taskById.get(entry.byTaskId);
			const estimate = task?.endedAt ?? task?.startedAt ?? previous;
			if (estimate !== undefined) {
				entry.at = estimate;
				entry.atEstimated = true;
			}
		}
		if (entry.at !== undefined) previous = entry.at;
	}

	const docsByConversation = new Map<number, LensDocument[]>();
	for (const document of documents) {
		if (document.scope.conversationId === undefined) continue;
		const list = docsByConversation.get(document.scope.conversationId) ?? [];
		list.push(document);
		docsByConversation.set(document.scope.conversationId, list);
	}

	const conversations: LensConversation[] = raw.conversations.filter((record) => num(record.id) !== undefined).map((record) => {
		const id = Number(record.id);
		const parent = isObject(record.parent) ? { conversationId: Number(record.parent.conversationId), at: Number(record.parent.at) } : undefined;
		const owner = isObject(record.owner) ? { conversationId: Number(record.owner.conversationId), taskId: Number(record.owner.taskId) } : undefined;
		const own = entries.filter((entry) => entry.conversationId === id);
		const docs = docsByConversation.get(id) ?? [];
		const usageDoc = docs.find((document) => document.kind === "pi.usage" && document.retiredAt === undefined);
		const usage = emptyUsage();
		if (isObject(usageDoc?.value)) {
			for (const bucket of ["models", "tools"]) {
				const values = usageDoc.value[bucket];
				if (isObject(values)) for (const value of Object.values(values)) addUsage(usage, toUsage(value));
			}
		} else {
			for (const entry of own) addUsage(usage, entry.usage);
		}
		const role: LensConversation["role"] = owner !== undefined ? "subagent" : parent !== undefined ? "fork" : id === 1 ? "root" : "conversation";
		const conversation: LensConversation = {
			id,
			role,
			label: role === "root" ? "Root" : role === "fork" ? `Fork of #${parent?.conversationId} at entry ${parent?.at}` : role === "subagent" ? `Subagent of task ${owner?.taskId}` : `Conversation #${id}`,
			entryIds: own.map((entry) => entry.id),
			children: [],
			usage,
		};
		if (parent !== undefined) conversation.parent = parent;
		if (owner !== undefined) conversation.owner = owner;
		const agent = docs.find((document) => document.kind === "pi.agent" && document.retiredAt === undefined);
		const model = modelName(agent?.value);
		if (model !== undefined) conversation.model = model;
		const title = own.find((entry) => entry.kind === "pi.user");
		const text = title === undefined ? undefined : firstText(title);
		if (text !== undefined) conversation.title = text.length > 120 ? `${text.slice(0, 117)}…` : text;
		const times = own.map((entry) => entry.at).filter((at): at is number => at !== undefined);
		if (times.length > 0) {
			conversation.firstAt = Math.min(...times);
			conversation.lastAt = Math.max(...times);
		}
		return conversation;
	});
	const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
	for (const conversation of conversations) {
		const up = conversation.parent?.conversationId ?? conversation.owner?.conversationId;
		if (up !== undefined) conversationById.get(up)?.children.push(conversation.id);
	}

	const usage = { total: emptyUsage(), byModel: {} as Record<string, LensUsage>, byTool: {} as Record<string, LensUsage> };
	for (const document of documents) {
		if (document.kind !== "pi.usage" || document.retiredAt !== undefined || !isObject(document.value)) continue;
		for (const [bucket, target] of [["models", usage.byModel], ["tools", usage.byTool]] as const) {
			const values = document.value[bucket];
			if (!isObject(values)) continue;
			for (const [key, value] of Object.entries(values)) {
				const counted = toUsage(value);
				target[key] ??= emptyUsage();
				addUsage(target[key], counted);
				addUsage(usage.total, counted);
			}
		}
	}
	for (const document of documents) if (document.error !== undefined) warnings.push(`document ${document.id} (${document.kind}): ${document.error}`);

	const { version, hints } = detectVersion(raw, tasks, entries);
	const lens: Lens = {
		source: {
			kind: raw.kind,
			path: options.displayPath ?? raw.path,
			files: raw.files,
			readAt: Date.now(),
			readMs: options.readMs ?? 0,
			attempts: raw.attempts,
		},
		format: { version, hints },
		restartLimit,
		conversations,
		entries,
		tasks,
		submissions,
		documents,
		usage,
		warnings,
	};
	if (options.decoder !== undefined) lens.source.decoder = options.decoder;
	if (raw.schemaVersion !== undefined) lens.format.schemaVersion = raw.schemaVersion;
	if (raw.jsonlFormat !== undefined) lens.format.jsonlFormat = raw.jsonlFormat;
	if (raw.prefix !== undefined) lens.format.prefix = raw.prefix;
	if (raw.nextSeq !== undefined) lens.format.nextSeq = raw.nextSeq;
	return lens;
}
