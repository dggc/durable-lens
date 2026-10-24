# JSON output

`durable-lens <store> --json` prints one JSON object, the **Lens**: the normalized view of a store that the page uses. `openLens()` in the library returns the same object. The TypeScript types are in `src/web/lens.ts` and are exported from the package.

The shape may change before 1.0. Fields can be added, renamed or removed in a 0.x release; the [CHANGELOG](../CHANGELOG.md) lists such changes. Optional fields are left out when there is no value. They are not `null`.

The output holds the content of your store: prompts, tool arguments and output, model answers, and file names. Treat it like the store. Do not attach it to an issue or a pull request.

## Top level

| Field | Type | Meaning |
|---|---|---|
| `source` | object | Where the data came from. |
| `format` | object | The storage format and the release range that wrote it. |
| `restartLimit` | number | The restart limit used to mark parked tasks: `--restart-limit`, or 5. |
| `conversations` | array | Every conversation. |
| `entries` | array | Every entry of every conversation, ordered by `id`. |
| `tasks` | array | Every task record. |
| `submissions` | array | Every submission record. |
| `documents` | array | Every document, with its current value. |
| `usage` | object | Cost and tokens in total, by model and by tool. |
| `warnings` | string[] | Problems found while reading. See [troubleshooting.md](troubleshooting.md). |

Records without a numeric `id` are left out of `conversations`, `entries`, `tasks`, `documents` and `submissions`, and a warning counts them. That is what an encrypted store looks like without a decoder.

## source

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"sqlite"` or `"jsonl"` | The storage kind. |
| `path` | string | The path as you typed it on the command line, not resolved. |
| `files` | array of `{ name, size, mtimeMs }` | The files that were read: the database and its `-wal`, `-journal` and `-shm` if they exist, or `main.jsonl` and the sidecars. |
| `readAt` | number | When the read finished, in milliseconds since the epoch. |
| `readMs` | number | How long the read took. |
| `attempts` | number | How many times the files were read or copied. More than 1 means the owner changed them during the read. |
| `decoder` | string, optional | The `--decoder` argument, when one was used. |

## format

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | number, optional | SQLite only. The value in `durable_schema`. |
| `jsonlFormat` | number, optional | JSONL only. Always 1 so far. |
| `prefix` | string, optional | The SQLite table prefix, when there is one. |
| `nextSeq` | number, optional | The next commit number. SQLite: from `durable_metadata`. JSONL: the last commit marker plus one. |
| `version` | string | The pi-durable release range that could have written the store, such as `pi-durable 1.4 or later` or `pi-durable 1.2–1.3`. |
| `hints` | string[] | Why `version` says that, for example `sleeping tasks: 1.4.0 or later`. |

## conversations[]

| Field | Type | Meaning |
|---|---|---|
| `id` | number | The conversation id. |
| `role` | `"root"`, `"fork"`, `"subagent"` or `"conversation"` | A conversation owned by a task is a `subagent`. One with a parent is a `fork`. Conversation 1 is the `root`. Anything else is a plain `conversation`. |
| `label` | string | A readable name, such as `Fork of #1 at entry 25`. |
| `parent` | `{ conversationId, at }`, optional | For a fork: the conversation it branched from, and the entry id where it branched. |
| `owner` | `{ conversationId, taskId }`, optional | For a subagent: the conversation and task that started it. |
| `model` | string, optional | `provider/modelId` from the conversation's live `pi.agent` document. |
| `title` | string, optional | The text of its first `pi.user` entry. A text longer than 120 characters is cut to 117 characters followed by `…`. |
| `entryIds` | number[] | The ids of its entries, in order. |
| `children` | number[] | The forks and subagents that hang from it. |
| `firstAt`, `lastAt` | number, optional | The earliest and latest entry time. |
| `usage` | usage | Its cost and tokens. From its live `pi.usage` document, summing the `models` and `tools` buckets. Without that document, the sum over its entries. |

## entries[]

| Field | Type | Meaning |
|---|---|---|
| `id` | number | The entry id. |
| `conversationId` | number | The conversation it belongs to. |
| `kind` | string | Such as `pi.user`, `pi.system`, `pi.assistant` and `pi.tool-result`. `?` if the record has none. |
| `seq` | number, optional | The commit that appended it. |
| `at` | number, optional | The time in milliseconds: the first message's own `timestamp`. |
| `atEstimated` | boolean, optional | `true` when there was no timestamp and `at` comes from the entry's task (`endedAt`, then `startedAt`) or from the previous entry. |
| `durationMs` | number, optional | The sum of the `durationMs` of its messages. For an assistant turn, the latency; for a tool result, the run time. |
| `byTaskId` | number, optional | The task that produced it. |
| `head` | number, optional | As stored. |
| `edits` | JSON, optional | As stored. |
| `messages` | JSON[] | The pi-ai messages the entry adds to the model context, as stored (the record's `model` field). |
| `data` | JSON, optional | The record's `data`, as stored. |
| `usage` | usage, optional | The usage of its assistant messages, summed. |
| `model` | string, optional | `provider/model` of its assistant message. |
| `stopReason` | string, optional | The assistant message's stop reason. |
| `errorMessage` | string, optional | The assistant message's error message. |

## tasks[]

| Field | Type | Meaning |
|---|---|---|
| `id` | number | The task id. |
| `kind` | string | Such as `pi.generation`, `pi.tool`, or your own `app.*` kinds. |
| `label` | string, optional | For `pi.tool`: the tool name. For `pi.generation`: the model of the entry it produced. |
| `version` | number, optional | The task record's version. |
| `conversationId` | number | The conversation it runs in. |
| `owner` | number, optional | The task that started it. |
| `children` | number[] | The tasks it owns. |
| `status` | string | `pending`, `running`, `waiting`, `sleeping` or `terminal`, as stored. `?` if missing. |
| `phase` | string, optional | `checkpoint.phase`, when the checkpoint has one. |
| `outcome` | `{ status, error?, reason?, result? }`, optional | Present once the task is terminal. |
| `background` | boolean | Whether it runs in the background. |
| `abortRequested` | boolean | Whether an abort was requested. |
| `abortReason` | string, optional | The reason given. |
| `startedAt`, `endedAt` | number, optional | Times, from pi-durable 1.1.0 on. |
| `restarts` | number, optional | How many times in a row it was restarted after a crash, from 1.4.0 on. |
| `parked` | boolean | `restarts` has reached `restartLimit`, the task is `pending` or `running`, and no abort was requested. pi-durable 1.4.0 and later does not run a parked task until `Harness.retryTask()`. |
| `until` | number, optional | For a `sleeping` task: when it wakes. |
| `on` | number[], optional | For a `waiting` task: the tasks it waits on. |
| `policy` | string, optional | For a `waiting` task: the wait policy, such as `allSettled`. |
| `input` | JSON, optional | As stored. |
| `checkpoint` | JSON, optional | As stored. |
| `memos` | JSON, optional | As stored. |
| `entryId` | number, optional | The entry the task produced, for generations and tool calls. |
| `callEntryId` | number, optional | For a tool task: the assistant entry that issued the call. |
| `callId` | string, optional | For a tool task: the tool call id. |

## documents[]

| Field | Type | Meaning |
|---|---|---|
| `id` | number | The document id. |
| `kind` | string | Such as `pi.agent`, `pi.usage`, `pi.inbox` or your own `app.*` kinds. |
| `key` | string, optional | The document key. |
| `scope` | `{ kind, conversationId?, taskId? }` | What the document belongs to. |
| `createdAt`, `retiredAt` | number, optional | The commit sequence number at which it was created or retired. |
| `history` | string, optional | `rewindable` or `latest`, as stored. |
| `fork` | string, optional | As stored, for example `initial` or `asOf`. |
| `version` | number, optional | The version of the newest revision. |
| `value` | JSON or `null` | The current value: the newest base with the deltas after it applied. |
| `error` | string, optional | Why `value` may be incomplete, such as `no base revision` or `could not apply revision: ...`. Also copied into `warnings`. |
| `revisions` | array of `{ seq, kind, version }` | The stored revisions. `kind` is `base` or `delta`. The content is not repeated. |
| `states` | array of `{ seq, value }`, optional | Only for `rewindable` documents: the value after each of the last 100 revisions, fewer if they add up to more than 4 MB. |

## submissions[]

| Field | Type | Meaning |
|---|---|---|
| `id` | number | The submission id. |
| `conversationId` | number | The conversation. |
| `type` | string | The submission type, such as `input`. |
| `status` | string | Such as `done`. |
| `entry` | number, optional | The entry it created. |
| `answer` | number, optional | The entry that answered it. |
| `reason` | string, optional | As stored. |
| `requestId` | string, optional | As stored. |

## usage

```json
{ "total": { }, "byModel": { }, "byTool": { } }
```

`total`, and each value of `byModel` and `byTool`, is a usage object: `{ input, output, cacheRead, cacheWrite, totalTokens, cost }`, with `cost` as one number, the `total` of the cost object that pi-ai records. The keys of `byModel` are `provider/modelId`; the keys of `byTool` are tool names. They come from the `pi.usage` documents of all conversations that have not been retired, which also count failed and aborted attempts, so they can differ from the sum over `entries`. A key may be any string, including `__proto__`; read these objects as data.

## Example

An excerpt of the 1.4.0 SQLite fixture, shortened:

```json
{
  "source": { "kind": "sqlite", "path": "session.sqlite", "files": [{ "name": "session.sqlite", "size": 147456, "mtimeMs": 1792837631574.1 }], "readAt": 1792837631652, "readMs": 39, "attempts": 1 },
  "format": { "version": "pi-durable 1.4 or later", "hints": ["SQLite schema v2: 1.4.0 or later"], "schemaVersion": 2, "nextSeq": 118 },
  "restartLimit": 3,
  "conversations": [
    { "id": 31, "role": "subagent", "label": "Subagent of task 30", "entryIds": [37, 40, 41], "children": [],
      "usage": { "input": 233, "output": 24, "cacheRead": 0, "cacheWrite": 233, "totalTokens": 490, "cost": 0.00015815 },
      "owner": { "conversationId": 1, "taskId": 30 }, "model": "faux/faux-small", "title": "Draft a patch for #412 with a regression test." }
  ],
  "tasks": [
    { "id": 76, "kind": "app.mirror-sync", "conversationId": 1, "children": [], "status": "pending", "background": true,
      "abortRequested": false, "parked": true, "restarts": 3, "checkpoint": { "phase": "sync" }, "phase": "sync" }
  ]
}
```
