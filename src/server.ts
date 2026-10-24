// The local web server: loopback only, one random token in every path, and nothing it serves loads from elsewhere.

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type OpenOptions, openLens } from "./open.ts";
import type { Lens } from "./web/lens.ts";

// The built page sits next to this file in dist/; from the TypeScript sources (tests), it is in ../dist/web.
const WEB = fileURLToPath(existsSync(new URL("./web/app.js", import.meta.url)) ? new URL("./web/", import.meta.url) : new URL("../dist/web/", import.meta.url));
const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
};
const SECURITY_HEADERS = {
	"Content-Security-Policy":
		"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
		"base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Cross-Origin-Opener-Policy": "same-origin",
	"X-Frame-Options": "DENY",
	"Cache-Control": "no-store",
};

export type ServeOptions = OpenOptions & {
	readonly host?: string;
	readonly port?: number;
	/** Poll the store's files with stat() and reread on change. Defaults to true. */
	readonly watch?: boolean;
	readonly pollMs?: number;
	readonly token?: string;
};

export type Running = {
	readonly url: string;
	/**
	 * A link that works once and redirects to `url`, for handing to a browser on its command line: command lines are
	 * visible to other local users, and the token in `url` gives read access to the whole store.
	 */
	readonly openLink: () => string;
	readonly server: Server;
	readonly lens: () => Lens | undefined;
	readonly close: () => Promise<void>;
};

/** Size and mtime of the store's files, read with stat() only; a stat that fails (EACCES, say) is part of the print. */
function fingerprint(path: string): string {
	try {
		return statFingerprint(path);
	} catch (error) {
		return `error:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
	}
}

function statFingerprint(path: string): string {
	const stat = statSync(path, { throwIfNoEntry: false });
	if (stat === undefined) return "missing";
	const parts: string[] = [];
	const add = (name: string, file: string) => {
		const info = statSync(file, { throwIfNoEntry: false });
		parts.push(info === undefined ? `${name}:-` : `${name}:${info.size}:${info.mtimeMs}`);
	};
	if (stat.isDirectory()) {
		// A JSONL store: the main file and its task and document sidecars.
		let names: string[] = [];
		try {
			names = readdirSync(path).filter((name) => name === "main.jsonl" || /^(doc|task)-\d+\.jsonl$/.test(name));
		} catch {
			parts.push("unreadable");
		}
		for (const name of names.sort()) add(name, join(path, name));
	} else {
		parts.push(`${stat.size}:${stat.mtimeMs}`);
		// The -shm changes with every read lock the owner takes and holds no data of its own, so it is left out.
		for (const suffix of ["-wal", "-journal"]) add(suffix, path + suffix);
	}
	return parts.join("|");
}

export async function serve(path: string, options: ServeOptions = {}): Promise<Running> {
	const host = options.host ?? "127.0.0.1";
	if (!LOOPBACK.has(host)) throw new Error(`durable-lens only listens on loopback (127.0.0.1 or ::1), not ${host}`);
	const token = options.token ?? randomBytes(18).toString("base64url");
	const prefix = `/${token}/`;
	const openCodes = new Set<string>();

	let lens: Lens | undefined;
	let error: string | undefined;
	let version = 0;
	let seen = "";
	let reading: Promise<void> | undefined;
	const reread = () => {
		reading ??= (async () => {
			// Taken before the read: a commit that lands while it runs then differs from `seen`, and the next poll rereads.
			const before = fingerprint(path);
			try {
				const next = await openLens(path, options);
				lens = next;
				error = undefined;
			} catch (cause) {
				error = (cause as Error).message;
			}
			seen = before;
			version++;
		})().finally(() => {
			reading = undefined;
		});
		return reading;
	};
	await reread();
	if (lens === undefined) throw new Error(error);

	const server = createServer((request, response) => handle(request, response));
	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(options.port ?? 0, host, () => done());
	});
	const { port } = server.address() as AddressInfo;
	const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

	const timer =
		options.watch === false
			? undefined
			: setInterval(() => {
					if (reading === undefined && fingerprint(path) !== seen) void reread();
				}, options.pollMs ?? 1000);
	timer?.unref();

	function send(response: ServerResponse, status: number, type: string, body: string | Buffer): void {
		response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
		response.end(body);
	}

	function handle(request: IncomingMessage, response: ServerResponse): void {
		// A page on another origin that rebinds its DNS name to 127.0.0.1 still sends its own Host.
		if (!allowedHosts.has(request.headers.host ?? "")) {
			send(response, 421, "text/plain", "wrong host\n");
			return;
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			send(response, 405, "text/plain", "read-only\n");
			return;
		}
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname.startsWith("/open/")) {
			if (!openCodes.delete(url.pathname.slice("/open/".length))) {
				send(response, 404, "text/plain", "link already used\n");
				return;
			}
			response.writeHead(302, { ...SECURITY_HEADERS, Location: prefix, "Content-Length": 0 });
			response.end();
			return;
		}
		if (!url.pathname.startsWith(prefix)) {
			send(response, 404, "text/plain", "not found\n");
			return;
		}
		const route = url.pathname.slice(prefix.length);
		if (route === "api/version") {
			send(response, 200, "application/json", JSON.stringify({ version, error: error ?? null }));
			return;
		}
		if (route === "api/lens") {
			send(response, 200, "application/json", JSON.stringify({ version, error: error ?? null, lens }));
			return;
		}
		const file = route === "" ? "index.html" : route;
		const extension = file.slice(file.lastIndexOf("."));
		if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(file) || TYPES[extension] === undefined) {
			send(response, 404, "text/plain", "not found\n");
			return;
		}
		let body: Buffer;
		try {
			body = readFileSync(join(WEB, file));
		} catch {
			send(response, 404, "text/plain", "not found\n");
			return;
		}
		send(response, 200, TYPES[extension] as string, body);
	}

	const origin = host === "::1" ? `http://[::1]:${port}` : `http://127.0.0.1:${port}`;
	return {
		url: `${origin}${prefix}`,
		openLink: () => {
			const code = randomBytes(18).toString("base64url");
			openCodes.add(code);
			return `${origin}/open/${code}`;
		},
		server,
		lens: () => lens,
		close: async () => {
			if (timer !== undefined) clearInterval(timer);
			await new Promise<void>((done) => server.close(() => done()));
		},
	};
}
