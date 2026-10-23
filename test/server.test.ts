// The local server: loopback only, token-scoped, read-only, and strict about what the page may load.
import assert from "node:assert/strict";
import { request } from "node:http";
import { describe, it } from "node:test";
import { serve } from "../src/server.ts";
import { fixture } from "./support.ts";

function get(url: string, options: { host?: string; method?: string } = {}): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
	const target = new URL(url);
	return new Promise((resolve, reject) => {
		const req = request(
			{ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: options.method ?? "GET", headers: { host: options.host ?? target.host } },
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

describe("server", async () => {
	it("refuses to listen beyond loopback", async () => {
		await assert.rejects(serve(fixture("1.4.0", "sqlite"), { host: "0.0.0.0" }), /loopback/);
	});

	it("serves the page and the store under its token only", async () => {
		const running = await serve(fixture("1.4.0", "sqlite"), { watch: false, token: "test-token" });
		try {
			const origin = new URL(running.url).origin;
			const page = await get(running.url);
			assert.equal(page.status, 200);
			assert.match(String(page.headers["content-security-policy"]), /default-src 'none'; script-src 'self'/);
			assert.equal(page.headers["x-content-type-options"], "nosniff");
			assert.match(page.body, /<script type="module" src="app.js">/);

			const lens = JSON.parse((await get(`${running.url}api/lens`)).body);
			assert.equal(lens.lens.entries.length, 27);
			assert.equal((await get(`${running.url}app.js`)).status, 200);

			assert.equal((await get(`${origin}/`)).status, 404, "no token");
			assert.equal((await get(`${origin}/wrong-token/api/lens`)).status, 404);
			assert.equal((await get(`${running.url}api/lens`, { host: "evil.example:80" })).status, 421, "DNS rebinding");
			assert.equal((await get(`${running.url}api/lens`, { method: "POST" })).status, 405);
			assert.equal((await get(`${running.url}..%2Fpackage.json`)).status, 404);
			assert.equal((await get(`${running.url}%2e%2e/%2e%2e/package.json`)).status, 404);
			assert.equal((await get(`${running.url}lens.d.ts`)).status, 404);
		} finally {
			await running.close();
		}
	});
});
