// The local server: loopback only, token-scoped, read-only, and strict about what the page may load.
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { type Running, serve } from "../src/server.ts";
import { copyFixture, fixture } from "./support.ts";

/** Whether this machine can listen on ::1 at all (some CI containers have no IPv6). */
const ipv6Loopback = await new Promise<boolean>((resolve) => {
	const probe = createServer();
	probe.once("error", () => resolve(false));
	probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** One request with the path exactly as given (no URL normalization), and an optional Host header. */
function send(origin: string, path: string, options: { host?: string; method?: string } = {}): Promise<Reply> {
	const target = new URL(origin);
	return new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: target.hostname.replace(/^\[(.*)\]$/, "$1"),
				port: target.port,
				path,
				method: options.method ?? "GET",
				headers: { host: options.host ?? target.host },
			},
			(response) => {
				let body = "";
				response.on("data", (chunk) => (body += chunk));
				response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

const get = (url: string, options: { host?: string; method?: string } = {}) => {
	const target = new URL(url);
	return send(target.origin, target.pathname + target.search, options);
};

async function withServer(test: (running: Running, origin: string) => Promise<void>, options: Parameters<typeof serve>[1] = {}): Promise<void> {
	const running = await serve(fixture("1.4.0", "sqlite"), { watch: false, token: "test-token", ...options });
	try {
		await test(running, new URL(running.url).origin);
	} finally {
		await running.close();
	}
}

const SECURITY_HEADERS = {
	"content-security-policy":
		/^default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/,
	"x-content-type-options": /^nosniff$/,
	"referrer-policy": /^no-referrer$/,
	"cross-origin-resource-policy": /^same-origin$/,
	"cross-origin-opener-policy": /^same-origin$/,
	"x-frame-options": /^DENY$/,
	"cache-control": /^no-store$/,
};

function assertSecure(reply: Reply, where: string): void {
	for (const [name, pattern] of Object.entries(SECURITY_HEADERS)) assert.match(String(reply.headers[name]), pattern, `${where}: ${name}`);
}

describe("server", () => {
	it("refuses to listen beyond loopback", async () => {
		for (const host of ["0.0.0.0", "::", "192.168.1.5", "localhost", ""]) {
			await assert.rejects(serve(fixture("1.4.0", "sqlite"), { host }), /loopback/, host);
		}
	});

	it("names the address it listens on, also on ::1", { skip: !ipv6Loopback && "no IPv6 loopback on this machine" }, async () => {
		await withServer(
			async (running) => {
				assert.match(running.url, /^http:\/\/\[::1\]:\d+\/test-token\/$/);
				assert.equal((await get(`${running.url}api/version`)).status, 200);
				const opened = await get(running.openLink());
				assert.equal(opened.status, 302);
				assert.equal(opened.headers.location, "/test-token/");
			},
			{ host: "::1" },
		);
	});

	it("refuses to start on a store it cannot read", async () => {
		await assert.rejects(serve(join(dirname(fixture("1.4.0", "sqlite")), "missing.sqlite")), /missing\.sqlite does not exist/);
	});

	it("keeps serving when the store can no longer be read at all, and recovers", { skip: process.getuid?.() === 0 && "root reads anything" }, async () => {
		const copy = copyFixture("1.4.0", "sqlite");
		const running = await serve(copy.store, { pollMs: 15, token: "t" });
		try {
			const until = async (done: (state: { version: number; error: string | null }) => boolean) => {
				for (let waited = 0; waited < 10_000; waited += 20) {
					const state = JSON.parse((await get(`${running.url}api/version`)).body) as { version: number; error: string | null };
					if (done(state)) return state;
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				throw new Error("no change seen");
			};
			// Not even stat() works on the store now: the poll must report it, not crash the process.
			chmodSync(copy.directory, 0o000);
			assert.match((await until((state) => state.error !== null)).error ?? "", /EACCES/);
			chmodSync(copy.directory, 0o700);
			assert.equal((await until((state) => state.error === null)).error, null);
		} finally {
			chmodSync(copy.directory, 0o700);
			await running.close();
			copy.dispose();
		}
	});

	it("serves the page, its scripts and styles, and the store, under its token", async () => {
		await withServer(async (running, origin) => {
			assert.equal(running.url, `${origin}/test-token/`);
			const page = await get(running.url);
			assert.equal(page.status, 200);
			assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
			assert.match(page.body, /<script type="module" src="app.js">/);
			assert.equal(page.body, (await get(`${running.url}index.html`)).body, "the root is index.html");

			const script = await get(`${running.url}app.js`);
			assert.equal(script.status, 200);
			assert.equal(script.headers["content-type"], "text/javascript; charset=utf-8");
			const styles = await get(`${running.url}styles.css`);
			assert.equal(styles.status, 200);
			assert.equal(styles.headers["content-type"], "text/css; charset=utf-8");
			assert.equal(Number(styles.headers["content-length"]), Buffer.byteLength(styles.body));
			const icon = await get(`${running.url}mark.svg`);
			assert.equal(icon.status, 200);
			assert.equal(icon.headers["content-type"], "image/svg+xml");
			assert.match(page.body, /<link rel="icon" href="mark.svg"/);

			const lens = JSON.parse((await get(`${running.url}api/lens`)).body);
			assert.equal(lens.error, null);
			assert.equal(lens.lens.entries.length, 27);
			assert.equal(lens.version, 1);
			assert.deepEqual(JSON.parse((await get(`${running.url}api/version`)).body), { version: 1, error: null });
		});
	});

	it("sends every security header on every kind of response", async () => {
		await withServer(async (running, origin) => {
			const replies: [string, Reply][] = [
				["page", await get(running.url)],
				["script", await get(`${running.url}app.js`)],
				["icon", await get(`${running.url}mark.svg`)],
				["api", await get(`${running.url}api/lens`)],
				["version", await get(`${running.url}api/version`)],
				["wrong token", await get(`${origin}/wrong/`)],
				["no token", await get(`${origin}/`)],
				["unknown file", await get(`${running.url}nope.js`)],
				["wrong host", await get(running.url, { host: "evil.example" })],
				["post", await get(running.url, { method: "POST" })],
				["open", await get(running.openLink())],
				["used open link", await get(`${origin}/open/used`)],
			];
			for (const [where, reply] of replies) assertSecure(reply, where);
		});
	});

	it("answers 404 for anything outside the token, whatever the path", async () => {
		await withServer(async (_running, origin) => {
			for (const path of [
				"/",
				"/wrong-token/",
				"/wrong-token/api/lens",
				"/test-token",
				"/test-tokenX/",
				"//test-token/",
				"/api/lens",
				"/open",
				"/favicon.ico",
			]) {
				assert.equal((await send(origin, path)).status, 404, path);
			}
			assert.equal((await send(origin, "/test-token/")).status, 200);
		});
	});

	it("allows only GET and HEAD, whatever the path", async () => {
		await withServer(async (running, origin) => {
			for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE"]) {
				assert.equal((await get(`${running.url}api/lens`, { method })).status, 405, method);
				assert.equal((await send(origin, "/nowhere", { method })).status, 405, `${method} outside the token`);
			}
			const head = await get(running.url, { method: "HEAD" });
			assert.equal(head.status, 200);
			assert.equal(head.body, "");
		});
	});

	it("rejects a Host that is not its own address, against DNS rebinding", async () => {
		await withServer(async (running) => {
			const port = new URL(running.url).port;
			for (const host of [
				"evil.example",
				`evil.example:${port}`,
				"127.0.0.1",
				`127.0.0.1:${Number(port) + 1}`,
				`127.0.0.1:${port}.evil.example`,
				`0.0.0.0:${port}`,
			]) {
				assert.equal((await get(`${running.url}api/lens`, { host })).status, 421, JSON.stringify(host));
			}
			// No Host header at all (HTTP/1.0) is no address either.
			const bare = await new Promise<string>((resolve, reject) => {
				const socket = connect({ host: "127.0.0.1", port: Number(port) }, () => socket.write(`GET ${new URL(running.url).pathname}api/lens HTTP/1.0\r\n\r\n`));
				let text = "";
				socket.on("data", (chunk) => (text += chunk));
				socket.on("end", () => resolve(text));
				socket.on("error", reject);
			});
			assert.match(bare, /^HTTP\/1\.1 421 /);
			for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
				assert.equal((await get(`${running.url}api/version`, { host })).status, 200, host);
			}
		});
	});

	it("serves only the static file types it ships, by plain name", async () => {
		await withServer(async (running, origin) => {
			const prefix = new URL(running.url).pathname;
			for (const name of [
				"..%2Fpackage.json",
				"%2e%2e/%2e%2e/package.json",
				"../package.json",
				"..%5Cpackage.json",
				"%2e%2e%2fpackage.json",
				"....//package.json",
				"app.js.map",
				"app.d.ts",
				"lens.d.ts",
				"APP.JS",
				"app.JS",
				"a/app.js",
				"%61pp.js/",
				"app.js%00.css",
				".env",
				"-.js",
				"nope.html",
				"nope.svg",
				"MARK.SVG",
				"api/lens/",
				"api/",
				"api/other",
				"state.ts",
				"tsconfig.json",
			]) {
				const reply = await send(origin, prefix + name);
				assert.notEqual(reply.status, 200, name);
				assert.ok([404, 400].includes(reply.status), `${name}: ${reply.status}`);
				assert.ok(!reply.body.includes('durable-lens",'), `${name} leaked a file`);
			}
		});
	});

	it("hands out a one-time open link that redirects to the tokened page", async () => {
		await withServer(async (running, origin) => {
			const link = running.openLink();
			assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]{24}$/);
			assert.ok(!link.includes("test-token"), "the link does not reveal the token");
			assert.notEqual(running.openLink(), link, "each link is new");
			const first = await get(link);
			assert.equal(first.status, 302);
			assert.equal(first.headers.location, "/test-token/");
			assert.equal(first.body, "");
			assert.equal((await get(link)).status, 404, "a second use fails");
			assert.equal((await get(`${origin}/open/guess`)).status, 404);
			assert.equal((await get(`${origin}/open/`)).status, 404);
			assert.equal((await get(running.openLink(), { host: "evil.example" })).status, 421, "and not for a foreign Host");
			assert.equal((await get(running.openLink(), { method: "POST" })).status, 405);
		});
	});

	it("picks a random token of its own when none is given", async () => {
		const first = await serve(fixture("1.4.0", "sqlite"), { watch: false });
		const second = await serve(fixture("1.4.0", "sqlite"), { watch: false });
		try {
			const [a, b] = [first, second].map((running) => new URL(running.url).pathname);
			assert.match(a as string, /^\/[\w-]{24}\/$/);
			assert.notEqual(a, b);
		} finally {
			await first.close();
			await second.close();
		}
	});

	it("stops answering after close", async () => {
		const running = await serve(fixture("1.4.0", "sqlite"), { watch: false });
		await running.close();
		await assert.rejects(get(running.url), /ECONNREFUSED/);
	});

	it("rereads a change that lands while a read is running", async () => {
		const copy = copyFixture("1.4.0", "jsonl");
		const main = join(copy.store, "main.jsonl");
		let armed = false;
		const running = await serve(copy.store, {
			pollMs: 15,
			decode: (value) => {
				if (armed) {
					armed = false;
					appendFileSync(main, "\n"); // a second commit, mid-read
				}
				return value;
			},
		});
		try {
			armed = true;
			appendFileSync(main, "\n"); // the first commit starts a reread
			for (let waited = 0; waited < 10_000; waited += 20) {
				const { version } = JSON.parse((await get(`${running.url}api/version`)).body) as { version: number };
				if (version >= 3) return;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.fail("the change made during the read was never read");
		} finally {
			await running.close();
			copy.dispose();
		}
	});

	it("rereads when the store's files change, and keeps the last good read when it breaks", async () => {
		const copy = copyFixture("1.4.0", "jsonl");
		const running = await serve(copy.store, { pollMs: 15, token: "t" });
		try {
			const version = async () => JSON.parse((await get(`${running.url}api/version`)).body) as { version: number; error: string | null };
			const until = async (done: (state: { version: number; error: string | null }) => boolean) => {
				for (let waited = 0; waited < 10_000; waited += 20) {
					const state = await version();
					if (done(state)) return state;
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				throw new Error(`no change seen: ${JSON.stringify(await version())}`);
			};
			assert.deepEqual(await version(), { version: 1, error: null });

			// An unrelated blank line changes the file's size and nothing else.
			appendFileSync(join(copy.store, "main.jsonl"), "\n");
			assert.deepEqual(await until((state) => state.version > 1), { version: 2, error: null });

			// A marker that cannot be read: the page keeps the last good store and gets the error.
			appendFileSync(join(copy.store, "main.jsonl"), '{"format":2,"type":"commit","seq":99,"writes":[]}\n');
			const broken = await until((state) => state.error !== null);
			assert.match(broken.error ?? "", /unknown marker format 2/);
			const lens = JSON.parse((await get(`${running.url}api/lens`)).body);
			assert.equal(lens.lens.entries.length, 27, "the last good read is still served");
			assert.match(lens.error, /unknown marker format 2/);

			writeFileSync(join(copy.store, "main.jsonl"), "");
			assert.equal((await until((state) => state.error === null && state.version > broken.version)).error, null);
			assert.equal(JSON.parse((await get(`${running.url}api/lens`)).body).lens.entries.length, 0);
		} finally {
			await running.close();
			copy.dispose();
		}
	});
});
