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
    supports: ["model", "sandbox", "force", "timeout", "readOnly"],
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

export const IMPLEMENTER_BY_KEY = Object.freeze(
  Object.fromEntries(IMPLEMENTERS.map((impl) => [impl.key, impl])),
);

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
