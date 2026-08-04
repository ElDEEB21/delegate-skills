# Setup dialogue details

Load this when running a configure / reconfigure session. The `SKILL.md` flow is authoritative; this page expands edge cases.

## Effective map (do not dump both files)

When loading existing config:

1. Run `node <skill-dir>/scripts/config.mjs load --cwd <dir>` (use the user’s cwd, or omit `--cwd`).
2. If `globalPresent` and `projectPresent` are both false → say “No lanes configured yet.”
3. Otherwise show a **table of effective lanes** from the `lanes` object. Include a Source column (`global` / `project`).
4. If `projectPresent` is true and `projectTrusted` is false, mark project lanes untrusted and explain
   that they cannot dispatch until the user approves a project write.
5. Paste both raw JSON files only if the user asks.

## Grounding the lane map

Ask the grounding menu as **one** question with three options (quick defaults / interview / usage
scan), then act on the answer. One question — never a wizard.

### The four interview questions

Allocation policy only. Users cannot rank model IDs — that is your job, not theirs.

| # | Ask | What it settles |
| --- | --- | --- |
| 1 | What kind of work do you delegate most? | The main lane — and its **name**. “migrations”, “bug triage”, “release-prep” beat the canned `feature`/`tests`/`ui`/`fast`/`complex` five |
| 2 | Which paid subscriptions should I burn, and which should I spare? | Quota economics. Discovery cannot see plans, limits, or what a run costs — only the user knows |
| 3 | Any CLI you already trust, or one that has burned you? | Lived experience outranks your priors about the underlying models |
| 4 | Default to fast and cheap, or slow and thorough? | Effort / variant dials, and who gets the `complex` lane |

Stop at four. Skip any the usage scan already answered.

### How to ask them

The questions are conversation, not a survey — cramming all four into one cold multiple-choice
form loses exactly what they exist to collect.

- **One medium per round.** Every question you ask in a turn goes through the same channel: all
  prose, or all in one form. Never mix the two — submitting a form ends the turn, so any prose
  question asked beside it is simply lost, and the silence that follows is not an answer to it.
- **Question 1 is open-ended.** You want the user's words — they become lane names. If your harness
  forces options, derive them from evidence (repo, usage scan, what the user has said), keep them one
  genre (kinds of work — never a mix of domains and task types, which overlap), and treat a selection
  as a draft lane name, not a category.
- **Questions 2 and 3 are set-valued.** The answer is a mapping across CLIs, so options must span the
  *discovered* CLIs — never an arbitrary subset — with both directions expressible: burn *and* spare,
  trust *and* burned-by. Multi-select if the harness has it; otherwise ask in prose.
- **Question 4 may be a closed choice.** Do not pre-mark an option as recommended — recommendations
  belong in the proposal, after the answers.
- **Lead with question 1.** Its answer usually reshapes or removes the others. Stop at four also
  means fewer is better.
- **Silence shrinks the map; it never gets substituted.** An unanswered question means a smaller,
  more conservative proposal: fewer lanes, and no dial on the axis it would have settled. Say what
  you are blind on in one line — “nobody told me which subscriptions to spare, so I set no effort
  dials; each CLI will use the default you configured” — and add that the answer is welcome anytime.
  Re-ask once if it matters. Never close the gap with your own preference.

### Reading a usage scan

`node <skill-dir>/scripts/discover.mjs --usage` adds `usage` to each discovered CLI:
`{ "sessions": <int>, "lastUsed": <ISO-8601 | null> }`, or `null`.

- Say what it does **before** running it: it counts session files and reads their timestamps. It never
  opens one, so no conversation content is read.
- `usage: null` = no probe wired for that CLI, or no local state directory. Unknown, not unused —
  never report it as zero.
- Large disparities are honest evidence: 1600 codex sessions against 20 pi sessions tells you where
  the user actually works. That earns the main lane.
- Small differences are noise. 97 against 61 decides nothing — fall back to the interview or to your
  opinion, and label it as such.
- `lastUsed` weighs as much as the count. A big count that stopped months ago is a CLI the user moved
  off; a recent date on a small count is one they are adopting.
- Counts are lifetime totals for that machine, not “this month”, and only cover sessions the CLI still
  keeps on disk.

### Labelling the basis

Give every proposed lane a Basis: `your answer`, `usage data`, `repo`, or `my opinion`. Use
`my opinion` whenever the choice came from your own sense of which model is better at the work —
including when discovery confirmed the CLI is installed and authenticated.

Label the parts separately when they differ. A lane whose implementer came from the usage scan but
whose model you chose is `usage + my opinion (model)`, never a flat `usage data` — session counts
say where the user works, not which model or effort level to buy for them. That split only exists in
quick-defaults mode, or when the user asked you for a dial: in the evidence modes you write no
opinion-dials, so there are none to label (see the consent-scope rules in `SKILL.md`).

Opinions about dials travel as an **addendum**, never as a pre-filled field. Show the table and the
JSON first, then, in a separate paragraph after it: “If you want my picks for models and effort
levels, say the word and I’ll add them.” Then wait. A dial the user asked for is theirs; the same
dial sitting inside the JSON they are about to approve spent their quota on your say-so.

## Scope

| User said / situation | Scope |
| --- | --- |
| “global”, “all projects”, “outside the repo/project” | `global` — do not re-ask |
| Not inside a git repository | Default `global` and say so |
| Inside a git repo, scope unspecified | Ask once: global vs this repo only |
| “this repo only” / “project” | `project` |

Never create `.delegate/config.json` merely because cwd is a git repo.

## Writing

1. Build the JSON document for **one scope only**. Start from that scope’s raw file
   (`config.mjs` paths: global or project), or `{ "version": "delegate-fleet.v1", "lanes": {} }`
   if it does not exist yet. Apply the approved edits there.
2. Do **not** write the effective merged map (stripping `source` from `load`). That would copy
   lanes across scopes: a project write would shadow global-only names, and a global write would
   promote project-only lanes everywhere. `write` replaces the chosen file wholesale.
3. Validate dials against [schema.md](schema.md) (or `config.mjs validate`).
4. Show table + full JSON again after every tweak.
5. On explicit approval, write via:

```bash
# Write the approved JSON to a uniquely named platform temp file first, then:
# global
node <skill-dir>/scripts/config.mjs write --scope global "$LANES_JSON"

# project
node <skill-dir>/scripts/config.mjs write --scope project --cwd <repo> "$LANES_JSON"
```

Use the `config.mjs write` command above so project approval is recorded correctly. Re-read with
`load` and confirm the path. A project write stores an approval hash under the worktree's
Git metadata; any later content change invalidates it and project lane dispatch fails closed until
re-approved. Remove the temp file after the write attempt, whether it succeeds or fails. Do not
hard-code `/tmp` (breaks on native Windows).

## Auth and models

- `authenticated: null` means unknown, not “logged out.” Usually it means no auth probe is wired for
  that CLI (currently `agy` and `pi`, which expose no status command) — say that rather than implying
  the login failed.
- Prefer not binding a lane to a CLI discover reports as `authenticated: false`.
- Do not invent model ids. Use `models.values` when `status` is `reported`, or ask the user, or omit `model` when the CLI has a safe default (OpenCode does **not** — require a model for opencode lanes).

## After write

Tell the user the path and active lane names. Remind them: later, pick the `*-delegate` skill matching the lane’s `implementer` and dispatch with `--lane <name>` (explicit `--model` / `--effort` / `--variant` still win). Do not start a delegate task unless they ask.
