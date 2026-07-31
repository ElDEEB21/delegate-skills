# Setup dialogue details

Load this when running a configure / reconfigure session. The `SKILL.md` flow is authoritative; this page expands edge cases.

## Effective map (do not dump both files)

When loading existing config:

1. Run `node <skill-dir>/scripts/config.mjs load --cwd <dir>` (use the user’s cwd, or omit `--cwd`).
2. If `globalPresent` and `projectPresent` are both false → say “No lanes configured yet.”
3. Otherwise show a **table of effective lanes** from the `lanes` object. Include a Source column (`global` / `project`).
4. Paste both raw JSON files only if the user asks.

## Scope

| User said / situation | Scope |
| --- | --- |
| “global”, “all projects”, “outside the repo/project” | `global` — do not re-ask |
| Not inside a git repository | Default `global` and say so |
| Inside a git repo, scope unspecified | Ask once: global vs this repo only |
| “this repo only” / “project” | `project` |

Never create `.delegate/config.json` merely because cwd is a git repo.

## Writing

1. Build the JSON document (`version` + `lanes` only — strip any `source` fields from the effective view).
2. Validate dials against [schema.md](schema.md) (or `config.mjs validate`).
3. Show table + full JSON again after every tweak.
4. On explicit approval, write via:

```bash
# global
node <skill-dir>/scripts/config.mjs write --scope global /tmp/lanes.json

# project
node <skill-dir>/scripts/config.mjs write --scope project --cwd <repo> /tmp/lanes.json
```

Prefer writing a temp JSON file then calling `write`, or write atomically yourself with the same schema checks. Re-read with `load` and confirm the path.

## Auth and models

- `authenticated: null` means unknown, not “logged out.”
- Prefer not binding a lane to a CLI discover reports as `authenticated: false`.
- Do not invent model ids. Use `models.values` when `status` is `reported`, or ask the user, or omit `model` when the CLI has a safe default (OpenCode does **not** — require a model for opencode lanes).

## After write

Tell the user the path and active lane names. Remind them: later, pick the `*-delegate` skill matching the lane’s `implementer` and pass `--lane <name>` once relays support it (Phase 2). Until then, use the map as orchestrator guidance and pass `--model` / `--effort` / `--variant` explicitly. Do not start a delegate task unless they ask.
