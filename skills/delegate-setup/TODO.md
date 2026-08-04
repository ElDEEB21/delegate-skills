# delegate-setup — improvement backlog

From first live test run, 2026-08-04 (macOS, all 8 CLIs installed).

Status: items 1–2 implemented (auth probes for codex/cursor/opencode/kimi/grok,
`failPattern`/`successPattern` support, model probes for grok/pi). Still open:
item 2's codex/claude/kimi model-listing decisions and item 4's dialogue note.

## 1. Auth probes missing for 7 of 8 implementers — DONE except agy/pi (no status cmd)

Only `claude` has an `authProbe`; everything else reports `authenticated: null`,
which reads as "unknown" even when the user is fully logged in. Verified probes:

| Key | Probe command | Verified output (logged in) | Notes |
| --- | --- | --- | --- |
| codex | `codex login status` | `Logged in using ChatGPT`, exit 0 | plain success/exit probe |
| cursor | `cursor-agent status` | `✓ Logged in as <email>`, exit 0 | may need output match, unclear if logged-out exits nonzero |
| opencode | `opencode auth list` | credential list, exit 0 | auth = at least one `●` credential row; exit 0 either way |
| kimi | `kimi provider list` | `source=oauth`, `models=4`, exit 0 | doubles as capability signal |
| grok | `grok models` | prints `You are not authenticated.` when logged out | doubles as model probe; match on that line → false |
| agy | `agy models` | model list on success | success implies auth; no dedicated status cmd found |
| pi | — | — | no obvious status command; `--list-models` succeeding implies at least one working provider |

### Design bug: `probeAuth` can never return `false` without `jsonField`

`discover.mjs` `probeAuth()`: probes without `jsonField` return `true` on exit 0
and `null` on failure — a logged-out CLI shows "unknown", not "false". Nonzero
exit is ambiguous (could be unknown-subcommand on an older CLI version).
Suggested: extend probe def with an output pattern, e.g.
`authProbe: { args, jsonField?, failPattern?, successPattern? }` so probes can
distinguish false (pattern matched) from null (probe itself broke).

## 2. Model listing missing for 5 of 10 implementers — grok/pi DONE, rest open

Normal users won't know model IDs; discovery must surface them. Verified:

| Key | Command | Output shape | Registry change |
| --- | --- | --- | --- |
| grok | `grok models` | header lines + `  * grok-4.5 (default)` bullets | new format parser: strip headers/bullets/`(default)` suffix. When logged out only the default model is listed — combine with auth probe. |
| pi | `pi --list-models` | table: `provider  model  context  max-out  thinking  images` | new `"table"` format: skip header, cols 1+2 → `provider/model`. NB: `pi models` (positional) is treated as a prompt and hits the API — do not use. |
| kimi | `kimi provider list` | providers + model counts, `Default model: kimi-code/k3` | shows counts, not IDs — check `kimi provider list` options for a per-model listing before settling |
| codex | read `~/.codex/models_cache.json` | JSON: `{ fetched_at, etag, client_version, models: [{ slug, display_name, default_reasoning_level, supported_reasoning_levels }] }` | no list *command* (`codex models` is treated as a prompt), but codex caches the full catalog locally — 8 slugs verified (gpt-5.6-sol/terra/luna, gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark, codex-auto-review). Needs a file-based modelProbe variant (probe type reads a file, not argv). Bonus: `supported_reasoning_levels` per model could validate the codex `effort` dial (includes `ultra`, which CLAUDE_EFFORT-style lists don't). Report `fetched_at` as cache age. |
| claude | none | `--model` help text says aliases exist (e.g. `sonnet`, `opus`) plus full names | option: static alias list in registry with a distinct `models.status: "aliases"` so the orchestrator knows they're curated, not discovered |

## 3. Observed on this machine (test data points)

- grok: `grok models` said "You are not authenticated." on first invocation,
  then "You are logged in with grok.com." on later runs — transient (likely a
  token refresh on first call). failPattern handles both states correctly.
- pi: first `pi models` attempt returned an OpenAI 403 HTML page — that was the
  positional-prompt trap, not a listing failure. `--list-models` works offline
  against configured providers (lmstudio/sakana/zai seen locally).

## 4. Orchestrator dialogue gaps noticed during the test run — partly DONE

## 5. Propose step: ground the lane map in evidence, not priors

Discovery reports capability (installed, auth, dials, model IDs) but zero
task-fit signal — so the orchestrator fills the gap with model-quality priors
and presents them with false authority ("feature → codex" reads as determined,
it was opinion). First live test: every lane assignment except claude's
confirmed auth was a prior. Fix in two parts:

**a) Basis column (mandatory, cheap).** The proposal table gets a Basis column
per lane: `your answer` / `usage data` / `repo` / `my opinion`. Kills the
false-authority problem regardless of which grounding path runs.

**b) Grounding menu (one question, not a wizard).** Before proposing, offer:

1. *Quick defaults* — disclosed opinion, zero friction. Must stay an option;
   lane maps are cheap to revise.
2. *Interview* — ~4 questions about allocation policy, never about models
   (users can't rank model IDs; that's the orchestrator's job):
   dominant work type (also yields better lane names than the canned five),
   which subscriptions to burn vs spare (quota economics are invisible to
   discovery — only the user knows), CLIs they trust/distrust from
   experience, fast-and-cheap vs slow-and-thorough bias.
3. *Usage scan* — metadata only: session counts + last-used mtimes from each
   CLI's local state (~/.codex/history.jsonl + sessions, ~/.kimi-code/sessions,
   cursor/grok/opencode equivalents). "codex 400 sessions this month, kimi 2"
   is honest evidence for the main lane. Never read session content — privacy
   cost is high, marginal value low. Prefer implementing as
   `discover.mjs --usage` (deterministic script output, testable, numbers not
   vibes) over SKILL.md prose telling the orchestrator to grep the home dir;
   cost is the script must know each CLI's state paths.

Combining 2+3 = run the scan first, then ask fewer questions. In a git repo,
the repo itself is a fourth source (languages, test weight, frontend share →
which lanes matter); the menu stays the same, only option 3 sees more.

Revised flow: `discover → load → grounding menu → propose (with Basis) →
scope → approve → write`.

- SKILL.md tells the orchestrator to summarize auth as true/false/null but
  gives no guidance to explain *why* null happens ("no probe wired") — first
  user reaction was "auth is configured, why unknown?". Once probes above land
  this mostly goes away; until then a one-liner in setup-dialogue.md would help.
