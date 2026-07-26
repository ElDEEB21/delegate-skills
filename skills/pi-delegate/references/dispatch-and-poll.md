# Dispatch and poll

`scripts/relay.mjs` wraps pi's headless prompt mode with `--mode json`, captures its structured event
stream, and writes a `result.json`. Run one command, then read one file.

## Before the first run

```bash
pi --version
```

Install the `pi` CLI according to its official documentation. Authenticate with your provider by
setting the relevant `*_API_KEY` environment variable.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

`<skill-dir>` is the installed folder containing this skill's `SKILL.md`.

| Flag | Effect |
| --- | --- |
| `--brief <file>` | Brief path. Omit it to read the brief from stdin. |
| `--cd <dir>` | Working root and child process cwd (default: current directory). |
| `--model <pattern>` | Model pattern or provider/id (e.g. `gpt-4o`, `openai/gpt-4o`, `sonnet:high`). |
| `--provider <name>` | Provider name (default: pi's configured default). |
| `--read-only` | Run in read-only mode: passes `--tools read,grep,find,ls` to restrict pi's tool surface. |
| `--session <id>` | Resume a specific pi session by UUID; send only the delta brief. |
| `--resume-last` | Continue the previous pi session (`-c`); send only the delta brief. |
| `--approve` | Trust project-local files for this run (default). |
| `--no-approve` | Ignore project-local files for this run. |
| `--timeout <dur>` | Relay watchdog (default: `30m`; h/m/s strings). Pi itself has no timeout flag. |
| `--out-dir <dir>` | Artifact directory (default: a fresh directory under the system temp dir). |
| `-h`, `--help` | Print the relay's header help. |

`--session` and `--resume-last` are mutually exclusive. The child cwd pins the primary workspace.

## Artifacts and result fields

Artifacts live outside the repo by default, so they do not appear in `touchedFiles`; an `--out-dir`
inside the worktree can make the artifacts appear there:

- `brief.txt` — the exact brief.
- `events.jsonl` — raw pi stdout events.
- `final.txt` — assistant text assembled from `message_end` content; absent if none was emitted.
- `stderr.txt` — complete stderr.
- `result.json` — the stable `delegate-relay.result.v1` contract.

`result.json` fields:

- `schema`, `tool` (`"pi"`), `status` (`completed` | `failed` | `timeout` | `aborted` | `pi_unavailable`), `exitCode`, and
  `signal` (`null` unless the child died on a signal).
- `workdir`, `model`, `provider`, `resumed`, `piVersion`, `sessionId`, `usage` (input, output,
  totalTokens, cost), `startedAt`, and `finishedAt`.
- `actualModel`, `actualProvider` — what pi actually used (parsed from the event stream, may
  differ from the requested `model`/`provider`).
- `readOnly` — whether `--read-only` was set for this run.
- `briefPath`, `finalPath`, `eventsPath`, and `stderrPath`.
- `finalMessage` — assistant `content[0].text` from each `message_end` event, joined with `"\n\n"`.
- `touchedFiles` — `git status --porcelain` lines for the **final working tree under `--cd` only**.
  `null` means git could not report; `[]` means git ran and the tree is clean.
- `stderrTail` — the last 20 non-empty stderr lines on any run that did not complete (`failed`,
  `timeout`, `aborted`), except a launch failure.
- `error` — present for launch failures, when the relay watchdog fires (`timeout`), and on an
  `aborted` run.

## Waiting for completion

The relay blocks. Use the orchestrator's background-command facility, or background it in a shell and
poll for `result.json`. The run is done only when the process exits and the file contains a `status`.

A pre-run usage error exits 2 and writes no result. A missing `pi` exits 127 and writes
`status: "pi_unavailable"`.

## When a run misbehaves

- **`status: "pi_unavailable"` (exit 127):** install the `pi` CLI, authenticate, and re-dispatch.
- **`status: "failed"`:** read `stderrTail`, `stderrPath`, and the tail of `events.jsonl`.
- **`status: "aborted"`:** the relay itself was killed and forwarded the kill to pi. Inspect the
  working tree before re-dispatching. On native Windows a hard kill of the relay is uncatchable, so
  this status may never get written — a relay process that is gone without a `result.json` is an
  aborted run.
- **`status: "timeout"`:** the `--timeout` watchdog killed the run; `error` reads
  `pi did not finish within --timeout <dur>; killed by the relay watchdog`. Increase `--timeout` or
  split the task.
- **Empty `finalMessage`:** inspect `touchedFiles` and the diff. Add a
  `<structured_output_contract>` to the next brief to require a closing report.

## What the relay runs

The argv is equivalent to:

```bash
pi --mode json --approve [--model <pattern>] [--provider <name>] [--session-id <id> | -c] \
  [--tools read,grep,find,ls] -p <brief>
```

The brief rides argv and is visible in the host process list. The relay rejects briefs over 12 KB on
Windows (120 KB on POSIX) before launch because the OS caps a single argument. It spawns with the
selected `--cd` as cwd; `shell: true` on Windows to resolve the `.cmd` shim, `shell: false` on POSIX.

## The commit boundary

The relay never commits. Pi edits the working tree; the orchestrator reviews, re-runs the gates, and
commits. See [review-and-land.md](review-and-land.md).
