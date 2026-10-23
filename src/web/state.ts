import type { Lens, LensConversation, LensDocument, LensEntry, LensTask } from "./lens.ts";

export type View = "timeline" | "tasks" | "documents" | "usage";

export type Route = {
	view: View;
	conversation: number;
	task?: number;
	document?: number;
	entry?: number;
	compare?: boolean;
	builtins?: boolean;
};

export type Index = {
	entries: Map<number, LensEntry>;
	tasks: Map<number, LensTask>;
	conversations: Map<number, LensConversation>;
	documents: Map<number, LensDocument>;
	/** Tool result entry of each `conversationId:callId`. */
	results: Map<string, LensEntry>;
	/** Tool task of each `assistantEntryId:callId`. */
	toolTasks: Map<string, LensTask>;
	/** Forks that branch at each entry. */
	forksAt: Map<number, LensConversation[]>;
	/** Conversations owned by each task. */
	ownedBy: Map<number, LensConversation[]>;
};

export function buildIndex(lens: Lens): Index {
	const index: Index = {
		entries: new Map(lens.entries.map((entry) => [entry.id, entry])),
		tasks: new Map(lens.tasks.map((task) => [task.id, task])),
		conversations: new Map(lens.conversations.map((conversation) => [conversation.id, conversation])),
		documents: new Map(lens.documents.map((document) => [document.id, document])),
		results: new Map(),
		toolTasks: new Map(),
		forksAt: new Map(),
		ownedBy: new Map(),
	};
	for (const entry of lens.entries) {
		for (const message of entry.messages) {
			if (message !== null && typeof message === "object" && !Array.isArray(message) && message.role === "toolResult") {
				index.results.set(`${entry.conversationId}:${String(message.toolCallId)}`, entry);
			}
		}
	}
	for (const task of lens.tasks) {
		if (task.callEntryId !== undefined && task.callId !== undefined) index.toolTasks.set(`${task.callEntryId}:${task.callId}`, task);
	}
	for (const conversation of lens.conversations) {
		if (conversation.parent !== undefined) {
			const list = index.forksAt.get(conversation.parent.at) ?? [];
			list.push(conversation);
			index.forksAt.set(conversation.parent.at, list);
		}
		if (conversation.owner !== undefined) {
			const list = index.ownedBy.get(conversation.owner.taskId) ?? [];
			list.push(conversation);
			index.ownedBy.set(conversation.owner.taskId, list);
		}
	}
	return index;
}

export function parseRoute(hash: string): Route {
	const params = new URLSearchParams(hash.replace(/^#/, ""));
	const number = (key: string) => {
		const value = params.get(key);
		return value === null || !/^\d+$/.test(value) ? undefined : Number(value);
	};
	const view = params.get("v");
	const route: Route = {
		view: view === "tasks" || view === "documents" || view === "usage" ? view : "timeline",
		conversation: number("c") ?? 1,
	};
	const task = number("t");
	const document = number("d");
	const entry = number("e");
	if (task !== undefined) route.task = task;
	if (document !== undefined) route.document = document;
	if (entry !== undefined) route.entry = entry;
	if (params.get("cmp") === "1") route.compare = true;
	if (params.get("all") === "1") route.builtins = true;
	return route;
}

export function routeHash(route: Route): string {
	const params = new URLSearchParams();
	params.set("v", route.view);
	params.set("c", String(route.conversation));
	if (route.task !== undefined) params.set("t", String(route.task));
	if (route.document !== undefined) params.set("d", String(route.document));
	if (route.entry !== undefined) params.set("e", String(route.entry));
	if (route.compare) params.set("cmp", "1");
	if (route.builtins) params.set("all", "1");
	return `#${params.toString()}`;
}

export type Context = {
	readonly lens: Lens;
	readonly index: Index;
	readonly route: Route;
	readonly go: (patch: Partial<Route>, replace?: boolean) => void;
	readonly link: (patch: Partial<Route>) => string;
};
