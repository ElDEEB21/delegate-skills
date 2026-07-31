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
 *   authProbe: null | { args: string[], jsonField?: string },
 *   modelProbe: null | { args: string[], format: "lines"|"cursor" },
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
    modelProbe: null,
    supports: ["model", "effort", "timeout", "readOnly"],
    winShell: true,
  },
  {
    key: "codex",
    skill: "codex-delegate",
    binary: "codex",
    versionArgs: ["--version"],
    authProbe: null,
    modelProbe: null,
    supports: ["model", "effort", "sandbox", "timeout", "readOnly"],
    winShell: true,
  },
  {
    key: "opencode",
    skill: "opencode-delegate",
    binary: "opencode",
    versionArgs: ["--version"],
    authProbe: null,
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
    authProbe: null,
    modelProbe: null,
    supports: ["model", "effort", "sandbox", "timeout", "readOnly"],
    winShell: true,
  },
  {
    key: "kimi",
    skill: "kimi-delegate",
    binary: "kimi",
    versionArgs: ["--version"],
    authProbe: null,
    modelProbe: null,
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
    authProbe: null,
    modelProbe: { args: ["--list-models"], format: "cursor" },
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
    modelProbe: null,
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
