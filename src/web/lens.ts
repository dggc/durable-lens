// The normalized view of one store that the server sends to the browser. Types only.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type LensUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
};

export type LensEntry = {
	id: number;
	conversationId: number;
	kind: string;
	/** Commit that appended it. */
	seq?: number;
	/** Wall-clock ms: the message's own timestamp, or estimated from its task or neighbours. */
	at?: number;
	atEstimated?: boolean;
	durationMs?: number;
	byTaskId?: number;
	head?: number;
	edits?: Json;
	/** pi-ai messages the entry contributes to model context, as stored. */
	messages: Json[];
	data?: Json;
	usage?: LensUsage;
	/** `provider/modelId` of an assistant message. */
	model?: string;
	stopReason?: string;
	errorMessage?: string;
};

export type LensConversation = {
	id: number;
	role: "root" | "fork" | "subagent" | "conversation";
	label: string;
	parent?: { conversationId: number; at: number };
	owner?: { conversationId: number; taskId: number };
	/** Model in its `pi.agent` document. */
	model?: string;
	title?: string;
	entryIds: number[];
	children: number[];
	firstAt?: number;
	lastAt?: number;
	usage: LensUsage;
};

export type LensTask = {
	id: number;
	kind: string;
	label?: string;
	version?: number;
	conversationId: number;
	owner?: number;
	children: number[];
	status: string;
	phase?: string;
	outcome?: { status: string; error?: Json; reason?: string; result?: Json };
	background: boolean;
	abortRequested: boolean;
	abortReason?: string;
	startedAt?: number;
	endedAt?: number;
	restarts?: number;
	/** `restarts` reached the restart limit: pi-durable 1.4.0+ parks the task until `Harness.retryTask()`. */
	parked: boolean;
	until?: number;
	on?: number[];
	policy?: string;
	input?: Json;
	checkpoint?: Json;
	memos?: Json;
	/** Entry the task produced, for generations and tool calls. */
	entryId?: number;
	/** Entry that issued the call, for tool tasks. */
	callEntryId?: number;
	callId?: string;
};

export type LensDocument = {
	id: number;
	kind: string;
	key?: string;
	scope: { kind: string; conversationId?: number; taskId?: number };
	createdAt?: number;
	retiredAt?: number;
	history?: string;
	fork?: string;
	version?: number;
	value: Json | null;
	error?: string;
	revisions: { seq: number; kind: "base" | "delta"; version: number }[];
	/** Value after each stored revision, for rewindable documents. */
	states?: { seq: number; value: Json }[];
};

export type LensSubmission = {
	id: number;
	conversationId: number;
	type: string;
	status: string;
	entry?: number;
	answer?: number;
	reason?: string;
	requestId?: string;
};

export type Lens = {
	source: {
		kind: "sqlite" | "jsonl";
		path: string;
		files: { name: string; size: number; mtimeMs: number }[];
		readAt: number;
		readMs: number;
		attempts: number;
		decoder?: string;
	};
	format: {
		schemaVersion?: number;
		jsonlFormat?: number;
		prefix?: string;
		nextSeq?: number;
		/** Release range that wrote this store, from the schema and the record shapes. */
		version: string;
		hints: string[];
	};
	restartLimit: number;
	conversations: LensConversation[];
	entries: LensEntry[];
	tasks: LensTask[];
	submissions: LensSubmission[];
	documents: LensDocument[];
	usage: { total: LensUsage; byModel: Record<string, LensUsage>; byTool: Record<string, LensUsage> };
	warnings: string[];
};
