# Fixture generator

`scenario.mjs` is one synthetic session, written by every pi-durable release under test with pi-ai's faux provider: no model calls, no real data. `v<version>/` pins one release; its `run.mjs` (a copy of `run.template.mjs`) imports that release and runs the scenario.

```sh
for v in 1.2.0 1.3.0 1.4.0; do (cd v$v && npm ci); done
node build.mjs            # every installed version, or: node build.mjs 1.4.0
```

`build.mjs` writes `../stores/<version>/{sqlite,jsonl}` (closed cleanly) and `{sqlite,jsonl}-crashed` (as the last crashing owner left it, SQLite WAL included).

The tests also use `run.mjs hold` and `run.mjs churn` to keep a real owner process on a store while durable-lens reads it.

## The unreleased main branch

`vmain/` runs a checkout of [earendil-works/pi](https://github.com/earendil-works/pi). Its packages must be built first, because their `exports` resolve to `dist/`:

```sh
git clone --filter=blob:none --sparse https://github.com/earendil-works/pi.git /path/to/pi
git -C /path/to/pi sparse-checkout set packages/durable packages/chord packages/ai packages/codemode packages/telemetry
(cd v1.4.0 && npm ci)
node link-main.mjs /path/to/pi    # copies v1.4.0's third-party modules, links the Earendil packages, records the commit
# build with the TypeScript the pi repository pins (7.0.2), in dependency order:
for p in telemetry chord codemode ai durable; do (cd /path/to/pi/packages/$p && npx -y -p typescript@7.0.2 tsc -p tsconfig.build.json); done
cp -r v1.4.0/node_modules/@earendil-works/pi-ai/dist/providers/data /path/to/pi/packages/ai/dist/providers/data
node build.mjs main
```

The last copy supplies pi-ai's generated model catalog, which the repository builds from the network and does not commit. The current fixtures come from commit 36be9c6 (2026-10-23).
