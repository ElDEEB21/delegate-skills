# Fleet schema (`delegate-fleet.v1`)

One concept: **lanes**. A lane names an implementer and optional dials.

## Document

```json
{
  "version": "delegate-fleet.v1",
  "lanes": {
    "feature": {
      "implementer": "opencode",
      "model": "grok",
      "variant": "high"
    },
    "tests": {
      "implementer": "grok",
      "effort": "medium"
    },
    "complex": {
      "implementer": "claude",
      "effort": "high"
    }
  }
}
```

- `version` must be `delegate-fleet.v1`.
- `lanes` is an object keyed by lane name (`[A-Za-z0-9][A-Za-z0-9._-]*`).
- Every lane **requires** `implementer` (a key from the registry below).
- Other fields are dials; only dials listed for that implementer are allowed.

## Paths

| Scope | Path |
| --- | --- |
| Global | `$XDG_CONFIG_HOME/delegate-skills/config.json` when `XDG_CONFIG_HOME` is set; otherwise `~/.config/delegate-skills/config.json` (`os.homedir()` → `HOME` / `USERPROFILE`) |
| Project | `<git-root>/.delegate/config.json` |

Project overlays global by **whole-lane replace** (same lane name in project fully replaces the global lane).

## Implementer keys and dials

| Key | Skill | Binary | Supported dials |
| --- | --- | --- | --- |
| `claude` | claude-delegate | `claude` | model, effort, timeout, readOnly |
| `codex` | codex-delegate | `codex` | model, effort, sandbox, timeout, readOnly |
| `opencode` | opencode-delegate | `opencode` | model, **variant**, timeout, readOnly |
| `agy` | agy-delegate | `agy` | model, timeout |
| `grok` | grok-delegate | `grok` | model, effort, sandbox, timeout, readOnly |
| `kimi` | kimi-delegate | `kimi` | model, timeout |
| `qoder` | qoder-delegate | `qodercli` | model, permissionMode, timeout, readOnly |
| `vibe` | vibe-delegate | `vibe` | timeout, readOnly |
| `cursor` | cursor-delegate | `cursor-agent` | model, sandbox, force, timeout, readOnly |
| `pi` | pi-delegate | `pi` | provider, model, timeout, readOnly |

OpenCode uses `variant` for reasoning intensity, not `effort`. Do not write `effort` on an `opencode` lane.

Boolean dials: `readOnly`, `force`. All other dials are non-empty strings. Duration strings for `timeout` use `h`/`m`/`s` (e.g. `30m`) when relays consume them in Phase 2.

## Helpers

```bash
node <skill-dir>/scripts/discover.mjs
node <skill-dir>/scripts/config.mjs load [--cwd <dir>]
node <skill-dir>/scripts/config.mjs validate <file>
node <skill-dir>/scripts/config.mjs write --scope global|project [--cwd <dir>] <file>
```

`load` prints the **effective** map (each lane includes a `source` of `global` or `project`).
