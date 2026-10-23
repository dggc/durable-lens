// Private temporary directories for SQLite snapshots. A snapshot is a full copy of someone's transcripts, so none may
// outlive the process: they are removed on exit, on SIGINT/SIGTERM/SIGHUP when the CLI handles them, and, for a process
// that was killed outright, by the next durable-lens run of the same user.

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = new Set<string>();
const NAME = /^durable-lens-(\d+)-[A-Za-z0-9]{6}$/;
let swept = false;

export function makeScratch(): { readonly path: string; readonly dispose: () => void } {
	if (!swept) {
		swept = true;
		sweepStale();
		process.once("exit", disposeScratch);
	}
	const path = mkdtempSync(join(tmpdir(), `durable-lens-${process.pid}-`));
	live.add(path);
	return {
		path,
		dispose: () => {
			rmSync(path, { recursive: true, force: true });
			live.delete(path);
		},
	};
}

/** Remove every snapshot directory this process still has. Synchronous, for exit and signal handlers. */
export function disposeScratch(): void {
	for (const path of live) {
		rmSync(path, { recursive: true, force: true });
		live.delete(path);
	}
}

/** Remove snapshot directories of this user's durable-lens processes that no longer run. */
function sweepStale(): void {
	const uid = process.getuid?.();
	let names: string[];
	try {
		names = readdirSync(tmpdir());
	} catch {
		return;
	}
	for (const name of names) {
		const pid = NAME.exec(name)?.[1];
		if (pid === undefined || Number(pid) === process.pid) continue;
		const path = join(tmpdir(), name);
		try {
			if (uid !== undefined && statSync(path).uid !== uid) continue;
			process.kill(Number(pid), 0);
		} catch (error) {
			// ESRCH: no such process, so its snapshot is stale. EPERM: it runs as someone else; leave it.
			if ((error as NodeJS.ErrnoException).code === "ESRCH") rmSync(path, { recursive: true, force: true });
		}
	}
}
