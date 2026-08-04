/**
 * Canonical implementer registry for delegate-setup.
 *
 * One table: skill key → binary, launch hints, supported lane dials, probes.
 * Consumed by discover.mjs and config.mjs. Relays will share this in Phase 2.
 *
 * Node built-ins only. No network, credentials, or telemetry.
 */

/** @typedef {"model"|"effort"|"variant"|"timeout"|"readOnly"|"sandbox"|"permissionMode"|"force"|"provider"} Dial */

/**
 * @type {readonly {
 *   key: string,
 *   skill: string,
 *   binary: string,
 *   versionArgs: string[],
 *   versionFallbackArgs?: string[],
 *   versionFormat?: "colon-prefix",
 *   authProbe: null | {
 *     args: string[],
 *     jsonField?: string,
 *     successPattern?: RegExp,
 *     failPattern?: RegExp,
 *   },
 *   modelProbe: null
 *     | { args: string[], format: "lines"|"cursor"|"grok"|"table"|"kimi-json" }
 *     | { envDir: string, homeSubdir: string, file: string, format: "codex-cache" }
 *     | { static: readonly string[] },
 *   supports: Dial[],
 *   winShell: boolean,
 * }[]}
 */
export const IMPLEMENTERS = Object.freeze([
  {
    key: "claude",
    skill: "claude-delegate",
    binary: "claude",
    versionArgs: ["--version"],
    authProbe: { args: ["auth", "status"], jsonField: "loggedIn" },
    // No listing command; `--model` takes one of these aliases or a full model name.
    modelProbe: { static: ["fable", "opus", "sonnet", "haiku"] },
    supports: ["model", "effort", "timeout", "readOnly"],
    winShell: true,
  },
  {
    key: "codex",
    skill: "codex-delegate",
    binary: "codex",
    versionArgs: ["--version"],
    // codex writes login status to stderr, not stdout.
    authProbe: {
      args: ["login", "status"],
      successPattern: /logged in/i,
      failPattern: /not logged in/i,
    },
    // Never spawn `codex models`: the positional word is read as a prompt and hits the API.
    // The locally cached catalog is the only offline listing.
    modelProbe: {
      envDir: "CODEX_HOME",
      homeSubdir: ".codex",
      file: "models_cache.json",
      format: "codex-cache",
    },
    supports: ["model", "effort", "sandbox", "timeout", "readOnly"],
    winShell: true,
  },
  {
    key: "opencode",
    skill: "opencode-delegate",
    binary: "opencode",
    versionArgs: ["--version"],
    // Exits 0 with an empty list too; a "●" row is the only auth signal.
    authProbe: { args: ["auth", "list"], successPattern: /^●\s/m },
    modelProbe: { args: ["models"], format: "lines" },
    // OpenCode reasoning intensity is --variant, not --effort.
    supports: ["model", "variant", "timeout", "readOnly"],
    winShell: true,
  },
  {
    key: "agy",
    skill: "agy-delegate",
    binary: "agy",
    versionArgs: ["changelog"],
    versionFormat: "colon-prefix",
    authProbe: null,
    modelProbe: { args: ["models"], format: "lines" },
    supports: ["model", "timeout"],
    winShell: false,
  },
  {
    key: "grok",
    skill: "grok-delegate",
    binary: "grok",
    versionArgs: ["version"],
    versionFallbackArgs: ["--version"],
    authProbe: { args: ["models"], failPattern: /not authenticated/i },
    modelProbe: { args: ["models"], format: "grok" },
    supports: ["model", "effort", "sandbox", "timeout", "readOnly"],
    winShell: true,
  },
  {
    key: "kimi",
    skill: "kimi-delegate",
    binary: "kimi",
    versionArgs: ["--version"],
    authProbe: { args: ["provider", "list"], successPattern: /source=(oauth|api)/ },
    // The JSON body also carries provider apiKey values; only `.models` keys may leave the parser.
    modelProbe: { args: ["provider", "list", "--json"], format: "kimi-json" },
    supports: ["model", "timeout"],
    winShell: false,
  },
  {
    key: "qoder",
    skill: "qoder-delegate",
    binary: "qodercli",
    versionArgs: ["--version"],
    authProbe: null,
    modelProbe: null,
    supports: ["model", "permissionMode", "timeout", "readOnly"],
    winShell: false,
  },
  {
    key: "vibe",
    skill: "vibe-delegate",
    binary: "vibe",
    versionArgs: ["--version"],
    authProbe: null,
    modelProbe: null,
    supports: ["timeout", "readOnly"],
    winShell: false,
  },
  {
    key: "cursor",
    skill: "cursor-delegate",
    binary: "cursor-agent",
    versionArgs: ["--version"],
    authProbe: {
      args: ["status"],
      successPattern: /logged in as/i,
      failPattern: /not logged in/i,
    },
    modelProbe: { args: ["models"], format: "cursor" },
    // cursor-agent has no --sandbox; autonomy is --force / --read-only.
    supports: ["model", "force", "timeout", "readOnly"],
    winShell: true,
  },
  {
    key: "pi",
    skill: "pi-delegate",
    binary: "pi",
    versionArgs: ["--version"],
    authProbe: null,
    // Must stay a flag: `pi models` is read as a prompt and hits the API.
    modelProbe: { args: ["--list-models"], format: "table" },
    supports: ["provider", "model", "timeout", "readOnly"],
    winShell: true,
  },
]);

/** Prototype-free map so names like "toString" cannot pass as implementers. */
export const IMPLEMENTER_BY_KEY = Object.freeze(
  IMPLEMENTERS.reduce((map, impl) => {
    map[impl.key] = impl;
    return map;
  }, Object.create(null)),
);

export const CLAUDE_EFFORT = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultracode"]);
export const CODEX_SANDBOX = Object.freeze(["read-only", "workspace-write", "danger-full-access"]);
export const GROK_SANDBOX = Object.freeze(["workspace", "read-only", "off"]);
export const QODER_PERMISSION = Object.freeze([
  "default",
  "accept_edits",
  "auto",
  "bypass_permissions",
  "dont_ask",
  "plan",
]);
/** Positive h/m/s duration, same shape relays accept. */
export const TIMEOUT_RE = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/**
 * Model/provider token shapes mirrored from each relay's parseArgs.
 * Relays that do not constrain the string still get a non-empty check in config.mjs.
 */
export const MODEL_TOKEN = Object.freeze({
  /** Keep in lockstep with claude-delegate SAFE_MODEL. */
  claude: /^[A-Za-z0-9][A-Za-z0-9._:@\/\[\]-]*$/,
  /** Keep in lockstep with cursor-delegate SAFE_MODEL. */
  cursor: /^[A-Za-z0-9][A-Za-z0-9._:@\/\[\]\,=-]*$/,
  /** Keep in lockstep with grok/pi/codex shell-safe tokens (also used for opencode). */
  shellSafe: /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/,
});

export const CONFIG_VERSION = "delegate-fleet.v1";
export const LANE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const ALL_DIALS = Object.freeze([
  "model",
  "effort",
  "variant",
  "timeout",
  "readOnly",
  "sandbox",
  "permissionMode",
  "force",
  "provider",
]);
