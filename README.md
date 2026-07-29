# delegate-skills

[![skills.sh](https://skills.sh/b/amElnagdy/delegate-skills)](https://skills.sh/amElnagdy/delegate-skills)

Skills for **delegating coding work to a separate CLI agent and landing it yourself**. Your agent (the
orchestrator) writes a self-contained brief, dispatches it to an implementer CLI, then reviews the diff
and commits — staying the reviewer the whole way.

Ten skills ship today — same loop, different implementer:

| Skill | Drives | Autonomy | Resume |
| --- | --- | --- | --- |
| `claude-delegate` | [Claude Code CLI](https://code.claude.com/docs/en/overview) | explicit tools + `acceptEdits`; strict shell-sandbox settings where supported; shell-free `--read-only`; bypass opt-in | `--resume-last`, `--session <id>` |
| `codex-delegate` | [OpenAI Codex CLI](https://github.com/openai/codex) | Codex `--sandbox` enum (`workspace-write` default) | `--resume-last`, `--session <id>` |
| `opencode-delegate` | [OpenCode CLI](https://opencode.ai) | agent: `build` (write) / `plan` (read-only) | `--resume-last`, `--session <id>` |
| `agy-delegate` | Google Antigravity CLI (`agy`) | Antigravity's own permission policy; bypass is opt-in | `--resume-last`, `--conversation <id>` |
| `grok-delegate` | Grok Build CLI (`grok`) | explicit: default workspace-scoped, `--read-only` best-effort with violation detection, `--full-access` opt-in | `--resume-last`, `--session <id>` |
| `kimi-delegate` | Kimi Code CLI (`kimi`) | headless runs always use Kimi's auto permission mode | `--resume-last`, `--session <id>` |
| `qoder-delegate` | [Qoder CLI](https://docs.qoder.com/en/cli/quick-start) (`qodercli`) | `auto` default; bypass is opt-in; effective mode is reported | `--resume-last`, `--resume <id>` |
| `cursor-delegate` | [Cursor Agent CLI](https://cursor.com/cli) (`cursor-agent`) | `--force` write default; `--no-force` withholds command approval; `--read-only` selects plan mode; `--trust` always | `--resume-last`, `--session <id>` |
| `vibe-delegate` | [Mistral Vibe CLI](https://github.com/mistralai/mistral-vibe) (`vibe`) | `accept-edits` default; `--full-access` selects `auto-approve`; `--plan-only` selects `plan` | `--resume-last`, `--session <id>` |
| `pi-delegate` | [Pi CLI](https://github.com/earendil-works/pi-mono) (`pi`) | full local tools by default (no sandbox, no permission modes); `--read-only` enforces a `read,grep,find,ls` tool surface | `--resume-last`, `--session <id>` |

## Install

Browse first:

```bash
npx skills add amElnagdy/delegate-skills --list
```

Install the package, or just one skill (any name from the table above):

```bash
npx skills add amElnagdy/delegate-skills
npx skills add amElnagdy/delegate-skills --skill codex-delegate
```

Install for a specific agent, or globally:

```bash
npx skills add amElnagdy/delegate-skills --skill codex-delegate --agent claude-code
npx skills add amElnagdy/delegate-skills --global
```

Works with any orchestrating agent the [Skills CLI](https://github.com/vercel-labs/skills) supports.

## What it does

The loop:

1. **Write a brief** — self-contained task context; the implementer has no orchestrator chat history.
2. **Dispatch** it with the bundled `relay.mjs`.
3. **Wait** for completion — the relay writes a structured `result.json`.
4. **Review** the diff — re-run the project's gates yourself; pair with [guard skills](https://github.com/amElnagdy/guard-skills).
5. **Land** it — *you* commit, because committing belongs to the reviewer.

```text
Use $claude-delegate to have a separate Claude Code session implement the parser fix, then review and commit it.
Use $codex-delegate to have Codex implement the refactor in services/billing/, then review and commit it.
Use $kimi-delegate to have Kimi implement the UI cleanup, then review and commit it.
Use $qoder-delegate to have Qoder implement the parser fix with a 32768-token context window, then review and commit it.
Use $pi-delegate to have Pi implement the parser fix, then review and commit it.
Use $codex-delegate to run this queue of migration tasks through Codex while I review each one.
```

Every relay speaks the same `delegate-relay.result.v1` contract: `status`, `exitCode`, `signal`
(with a host-killed hint when the OOM killer ends a run), the implementer's own final report,
`touchedFiles`, and a session/conversation id where the CLI exposes one. Learn the loop once, swap the
implementer freely.

## The skills

### claude-delegate

Drive a separate Claude Code CLI session through `claude -p`, with the brief on stdin and the raw
stream-json artifacts kept for review. The normal profile pairs `acceptEdits` with an explicit tool
surface; where Claude's shell sandbox exists (macOS, Linux, WSL2) the relay requires it and disables
the unsandboxed retry, so ordinary gates still run headlessly. `--read-only` drops to plan mode with
Read, Glob, and Grep, then flags a changed git-porcelain snapshot. The skill docs carry the boundary
caveats — that sandbox covers shell processes only, hooks run outside the restricted tool surface, and
`AGENTS.md` is never auto-loaded.

It complements Claude's own subagents, agent teams, and background sessions: those coordinate inside
Claude Code, while this keeps the brief → dispatch → artifact → review → land contract portable across
orchestrators, with the commit on the reviewer.

### codex-delegate

Drive the OpenAI Codex CLI as a background implementer. Ships four references (writing the brief,
dispatch/poll, review/land, multi-task queues) loaded only when needed, and one small helper script.

**You'll feel it when:** a bounded task — a migration, a mechanical refactor, a removal sweep — gets
handed to Codex, comes back as a clean diff with a structured report, and you commit it after re-running
the gates yourself instead of typing it all by hand.

### opencode-delegate

Same loop for the OpenCode CLI. Autonomy is set by the **agent** rather than a sandbox enum — `build`
(write-capable) by default, `plan` (read-only) for review/diagnosis — and the brief is piped to
`opencode run` on stdin so multi-line XML briefs need no quoting. `--model` is required: OpenCode has
no safe default, so you name a model you actually pay for.

### agy-delegate

Same loop for the Google Antigravity CLI (`agy`). Fresh runs start a new Antigravity project and
explicitly add the target repo as the workspace; Antigravity's permission bypass
(`--dangerously-skip-permissions`) is opt-in, never the default, and combining it with `--sandbox`
must be treated as full access.

### grok-delegate

Same loop for the Grok Build CLI. Autonomy is always set explicitly because Grok's headless default
would hang a pipe: workspace-scoped by default, `--full-access` as the opt-in, and `--read-only` as
**best-effort** — Grok cannot be prevented from writing headlessly, so the relay snapshots the tree
and flags `readOnlyViolation: true` when a read-only run wrote anyway.

### kimi-delegate

Same loop for the Kimi Code CLI (`kimi`). Headless `kimi -p` always runs in Kimi's auto permission
mode (it rejects `--yolo`/`--auto`/`--plan` outright), so the skill is blunt about it: there is no
CLI-enforced read-only mode — `touchedFiles` and the diff, not a flag, are the guarantee.

### qoder-delegate

Same loop for Qoder CLI (`qodercli`). The relay verifies the installed binary and forwards a requested
model; the skill requires the orchestrator to select that name from the account's live
`qodercli --list-models` output. It also forwards an optional positive `--context-window` value for
models that support explicit sizing. Non-interactive runs use Qoder's `auto` permission mode by
default; bypass remains opt-in. Qoder falls back to `default` outside a trusted directory, so the
relay records both the requested and effective modes.

### cursor-delegate

Same loop for the Cursor Agent CLI (`cursor-agent`). The brief rides stdin (no process-list
exposure, no argv-size cap). A fresh run is write-capable with `--force` — Cursor runs commands
without approval unless the user's Cursor config denies them. `--no-force` withholds automatic
command approval while retaining file edits, and `--read-only` switches to Cursor's plan mode. The
relay always passes `--trust`, so `--cd` must only point at repositories the user trusts. The model
Cursor actually served, permission mode, and usage are recorded in `result.json`.

### vibe-delegate

Same loop for the Mistral Vibe CLI (`vibe`). Normal runs use `accept-edits`, which permits Vibe's
built-in file edits but rejects tools that still require approval in headless mode. `--full-access`
is the explicit opt-in to `auto-approve`; `--plan-only` selects Vibe's read-only `plan` agent.
The relay always passes `--trust` to skip only the directory-trust prompt — it does not grant tool
permissions or add a sandbox. Turn and token limits can bound a run; `--max-price` is indicative, not
a hard budget. Vibe's streaming output does not expose the new session id, so use `--resume-last`
unless you already know a specific id.

### pi-delegate

Same loop for the Pi coding agent CLI (`pi`). The brief rides stdin to `pi --mode json` — no argv
size cap, nothing in the host process list — and the relay lifts the session id from the JSON
event stream for later resume. Pi has no sandbox and no permission modes: a default headless run
writes and executes without prompts, so the guarantees are `--read-only` (an enforced
`read,grep,find,ls` tool surface, covering extension tools too) and the diff. Project `.pi`
resources stay untrusted unless the orchestrator explicitly opts in.

### gemini-delegate

*Planned.* A delegate skill for the Gemini CLI, if and when it gains a comparable non-interactive mode.
Reserved so the umbrella can grow without a rename.

## How this differs from the OpenAI Codex plugin

The official openai-codex Claude Code plugin is excellent and **complementary** — `codex-delegate`
builds on the same `codex` CLI, it doesn't replace the plugin. They point in different directions:

- The plugin's `codex:codex-rescue` agent is a **forwarder**: it hands one task to Codex and returns
  the output. It deliberately does not poll, review, or commit.
- The plugin's review command and stop-review gate run the **inverse** direction: **Codex reviews your work**.
- `codex-delegate` is the **orchestration loop in the other direction**: *you* drive Codex to
  implement across one task or a queue, and *you* review and land each result. That loop — brief →
  dispatch → poll → review → commit, with the orchestrator owning the commit — is what the plugin
  leaves to you, and what this skill encodes.

If you have the plugin installed, its companion CLI is an optional alternative dispatch backend; the
bundled `relay.mjs` is the default because it needs nothing but the `codex` binary.

## Requirements

- The implementer CLI for the skill you install, authenticated as you would at the terminal:
  [`claude`](https://code.claude.com/docs/en/setup) (`claude auth login`) ·
  [`codex`](https://github.com/openai/codex) (`codex login`) ·
  [`opencode`](https://opencode.ai) (`opencode auth login`) · `agy` (Antigravity's first-launch setup) ·
  `grok` (`npm i -g @xai-official/grok`, then `grok login`) ·
  [`kimi`](https://moonshotai.github.io/kimi-code/en/) (`brew install kimi-code`, then `kimi login`) ·
  [`qodercli`](https://docs.qoder.com/en/cli/quick-start) (`qodercli login`, or
  `QODER_PERSONAL_ACCESS_TOKEN` for automation) ·
  [`cursor-agent`](https://cursor.com/cli) (`cursor-agent login`) ·
  [`vibe`](https://github.com/mistralai/mistral-vibe) ([install `uv`](https://docs.astral.sh/uv/getting-started/installation/),
  then run `uv tool install mistral-vibe` and configure `MISTRAL_API_KEY`) ·
  [`pi`](https://github.com/earendil-works/pi-mono) (`npm install -g @earendil-works/pi-coding-agent`,
  then `/login` or an API-key environment variable).
- Node 18+ and `git`.
- An orchestrating agent that can run shell commands and read files.
- Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows).

## Trust and validation

This package is intentionally inspectable:

- All skill content is Markdown, plus exactly **one** executable per skill — each a `scripts/relay.mjs`.
- Each `relay.mjs` makes no network calls, reads or writes no credentials, sends no telemetry, and has
  no dependencies (Node built-ins only). It launches its implementer CLI and `git`, plus the platform
  process launcher/termination utility where a Windows shim or process-tree kill requires one. The
  implementer CLI authenticates exactly as you do at the terminal. Read the script before you run it.
- None of the relays ever commit — committing is always the orchestrator's job, after review.

**Verification status** — claims here are backed by runs, not assumptions:

- The previously shipped relays' mechanics are verified: argument handling, exit codes,
  `result.json`, resume, signal reporting, and the implementer-specific guards.
- `claude-delegate` — verified end-to-end on macOS against `claude` 2.1.220 (write run under
  `acceptEdits`; plan mode refusing an edit, with the porcelain tripwire true on a violation and false
  on a clean run; `--session`/`--resume-last` resume; `claude_unavailable`/127 and usage errors exiting
  2 without a result file; deny rules and the shell sandbox blocking `git commit`, `git push`,
  `git -C <dir> push`, a nested `claude`, and a `$HOME` write). CI drives its launch, timeout, and
  abort paths against a stand-in binary on Linux and Windows; a native Windows launch is unverified.
- `agy-delegate` — verified end-to-end on macOS against `agy` 1.0.16 (headless edit run, `--print=`
  delivery, absolute `--add-dir` workspace pin).
- `grok-delegate` — verified end-to-end on macOS against `grok` 0.2.101 (streaming-json report capture,
  file-based brief delivery, resume; read-only is best-effort by measurement, hence the violation flag).
- `kimi-delegate` — verified end-to-end on macOS against `kimi` 0.24.0 (headless `-p` edit run,
  stream-json parsing, `--session`/`--continue` resume).
- `qoder-delegate` — contract-tested for argument validation, bounded version preflight, missing binary, model/context
  forwarding, result parsing, and whole-process-tree timeout/abort cleanup; verified end-to-end on
  macOS by the contributor against `qodercli` 1.0.47 (Lite edit run, `accept_edits`, explicit model
  and 32768-token context window, no commit).
- `pi-delegate` — contributor-reported end-to-end on macOS (stdin brief delivery, a write
  run, `--read-only` leaving a clean tree, `--session`/`--resume-last` resume, session-id capture
  from the JSON stream, a bad-model failure, watchdog timeout felling the process tree,
  `pi_unavailable`/127, and usage errors exiting 2 without artifacts). The shared relay suite is
  configured to drive its timeout, abort, success, and preflight paths against a stand-in binary
  on Linux and Windows; a native Windows launch is unverified.
- `opencode-delegate` — requires `--model`, since OpenCode has no safe default.
- `cursor-delegate` — verified end-to-end on Windows against `cursor-agent` 2026.07.23-e383d2b (write run
  under `--force` editing real files; plan-mode `--read-only` run touching nothing;
  `--session <id>` resume applying a delta brief in the same session; usage errors exiting 2 without
  a result file). The shared relay-smoke suite covers model/session/add-directory forwarding,
  `--no-force`, usage, bounded version preflight, atomic artifacts, and timeout/abort handling, and
  is configured in CI on Linux and Windows. A maintainer-run native macOS plan-mode smoke against
  the same version completed with model/session/usage capture and no touched files; a native Linux
  run is unverified.
- `vibe-delegate` — contract-tested for launch-mode, resume, tool-filter, and turn/price/token
  forwarding; bounded version preflight; result parsing; and whole-process-tree timeout/abort
  cleanup. A live Vibe run and native Windows launch are unverified.
- Windows: the codex/opencode/grok/pi launches handle the `.cmd` shim (`shell:true` + validated
  values where needed); Pi's brief rides stdin. Cursor serializes a pre-joined, quoted command
  through the shell; Qoder and Vibe target their currently documented native executables. Native
  Windows launch smokes for `claude`/`agy`/`grok`/`kimi`/`qoder`/`vibe`/`pi` are still pending.
  Claude's own shell sandbox is
  unsupported on native Windows regardless of launch mechanics. Upstream Vibe works on Windows but
  officially supports and targets UNIX; this repository has not smoke-tested the Vibe relay's native
  Windows launch.
- The full delegate → review → commit loop is designed for and run on Claude Code; other orchestrators
  (Cursor, …) are designed-for but unproven.

## Repository shape

Every skill has the same shape — a lean `SKILL.md`, four references that load only when needed, and
one inspectable script:

```text
skills/
└── <name>-delegate/
    ├── SKILL.md
    ├── scripts/relay.mjs
    └── references/
        ├── writing-the-brief.md
        ├── dispatch-and-poll.md
        ├── review-and-land.md
        └── multi-task-queues.md
```

## License

MIT — see [LICENSE](LICENSE).
