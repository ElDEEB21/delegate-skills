#!/usr/bin/env node
/**
 * config.mjs — load, merge, validate, and write delegate-fleet.v1 lane maps.
 *
 * Usage:
 *   node config.mjs load [--cwd <dir>]
 *   node config.mjs validate <file>
 *   node config.mjs write --scope global|project [--cwd <dir>] <file>
 *   node config.mjs --help
 *
 * Node built-ins only. No network, credentials, or telemetry.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  ALL_DIALS,
  CONFIG_VERSION,
  IMPLEMENTER_BY_KEY,
  LANE_NAME,
} from "./implementers.mjs";

const HELP = `config.mjs — load / validate / write delegate-fleet.v1 lane maps

Usage:
  node config.mjs load [--cwd <dir>]
  node config.mjs validate <file>
  node config.mjs write --scope global|project [--cwd <dir>] <file>
  node config.mjs --help

Paths:
  global   ~/.config/delegate-skills/config.json
  project  <git-root>/.delegate/config.json  (requires a git repo)

load prints the effective lane map (project whole-lane replaces global) as JSON.
`;

export function globalConfigPath() {
  // Prefer XDG when set; otherwise ~/.config (homedir() → HOME / USERPROFILE).
  const base = process.env.XDG_CONFIG_HOME
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), ".config");
  return join(base, "delegate-skills", "config.json");
}

export function findGitRoot(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return null;
  const root = (r.stdout || "").trim();
  return root || null;
}

export function projectConfigPath(cwd) {
  const root = findGitRoot(cwd);
  if (!root) return null;
  return join(root, ".delegate", "config.json");
}

function fail(message) {
  process.stderr.write(`config.mjs: ${message}\n`);
  process.exit(2);
}

/**
 * @returns {{ ok: true, document: object } | { ok: false, error: string }}
 */
export function parseConfigDocument(raw, label = "config") {
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `${label}: invalid JSON (${error.message})` };
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, error: `${label}: expected a JSON object` };
  }
  if (document.version !== CONFIG_VERSION) {
    return {
      ok: false,
      error: `${label}: unsupported version ${JSON.stringify(document.version)} (expected ${CONFIG_VERSION})`,
    };
  }
  if (!document.lanes || typeof document.lanes !== "object" || Array.isArray(document.lanes)) {
    return { ok: false, error: `${label}: lanes must be an object` };
  }
  for (const [name, lane] of Object.entries(document.lanes)) {
    const laneError = validateLane(name, lane, label);
    if (laneError) return { ok: false, error: laneError };
  }
  return { ok: true, document };
}

function validateLane(name, lane, label) {
  if (!LANE_NAME.test(name)) {
    return `${label}: invalid lane name ${JSON.stringify(name)}`;
  }
  if (!lane || typeof lane !== "object" || Array.isArray(lane)) {
    return `${label}: lane ${name} must be an object`;
  }
  if (typeof lane.implementer !== "string" || !IMPLEMENTER_BY_KEY[lane.implementer]) {
    return `${label}: lane ${name} needs implementer (one of: ${Object.keys(IMPLEMENTER_BY_KEY).join(", ")})`;
  }
  const impl = IMPLEMENTER_BY_KEY[lane.implementer];
  for (const field of Object.keys(lane)) {
    if (field === "implementer") continue;
    if (!ALL_DIALS.includes(field)) {
      return `${label}: lane ${name} has unknown field ${JSON.stringify(field)}`;
    }
    if (!impl.supports.includes(field)) {
      return `${label}: lane ${name}: ${impl.key} does not support ${field} (supports: ${impl.supports.join(", ") || "none"})`;
    }
    if (field === "readOnly" || field === "force") {
      if (typeof lane[field] !== "boolean") {
        return `${label}: lane ${name}.${field} must be a boolean`;
      }
    } else if (typeof lane[field] !== "string" || lane[field].length === 0) {
      return `${label}: lane ${name}.${field} must be a non-empty string`;
    }
  }
  return null;
}

export function readConfigFile(path) {
  if (!path || !existsSync(path)) return null;
  const parsed = parseConfigDocument(readFileSync(path, "utf8"), path);
  if (!parsed.ok) throw new Error(parsed.error);
  return { path, document: parsed.document };
}

/**
 * Effective lanes: start from global, whole-lane replace from project.
 */
export function effectiveLanes(globalDoc, projectDoc) {
  /** @type {Record<string, { lane: object, source: "global"|"project" }>} */
  const out = {};
  if (globalDoc?.lanes) {
    for (const [name, lane] of Object.entries(globalDoc.lanes)) {
      out[name] = { lane: { ...lane }, source: "global" };
    }
  }
  if (projectDoc?.lanes) {
    for (const [name, lane] of Object.entries(projectDoc.lanes)) {
      out[name] = { lane: { ...lane }, source: "project" };
    }
  }
  return out;
}

export function loadEffective(cwd = process.cwd()) {
  const globalPath = globalConfigPath();
  const projectPath = projectConfigPath(cwd);
  const globalFile = readConfigFile(globalPath);
  const projectFile = projectPath ? readConfigFile(projectPath) : null;
  const effective = effectiveLanes(globalFile?.document, projectFile?.document);
  return {
    version: CONFIG_VERSION,
    globalPath,
    projectPath,
    globalPresent: Boolean(globalFile),
    projectPresent: Boolean(projectFile),
    lanes: Object.fromEntries(
      Object.entries(effective).map(([name, { lane, source }]) => [
        name,
        { ...lane, source },
      ]),
    ),
  };
}

export function writeAtomic(targetPath, document) {
  const parsed = parseConfigDocument(JSON.stringify(document), "write payload");
  if (!parsed.ok) throw new Error(parsed.error);
  mkdirSync(dirname(targetPath), { recursive: true });
  // Temp file must live beside the target: renameSync across drives fails on Windows (EXDEV).
  const tmp = join(
    dirname(targetPath),
    `.config.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    writeFileSync(tmp, `${JSON.stringify(parsed.document, null, 2)}\n`, "utf8");
    renameSync(tmp, targetPath);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

function main(argv) {
  try {
    if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
      process.stdout.write(HELP);
      process.exit(argv.length === 0 ? 2 : 0);
    }

    const cmd = argv[0];
    let cwd = process.cwd();
    const cwdIdx = argv.indexOf("--cwd");
    if (cwdIdx !== -1) {
      if (!argv[cwdIdx + 1]) fail("--cwd needs a directory");
      cwd = resolve(argv[cwdIdx + 1]);
    }

    if (cmd === "load") {
      process.stdout.write(`${JSON.stringify(loadEffective(cwd), null, 2)}\n`);
      return;
    }

    if (cmd === "validate") {
      const file = argv.find((a, i) => i > 0 && a !== "--cwd" && argv[i - 1] !== "--cwd");
      if (!file) fail("validate needs a file path");
      const parsed = parseConfigDocument(readFileSync(resolve(file), "utf8"), file);
      if (!parsed.ok) fail(parsed.error);
      process.stdout.write(`${JSON.stringify({ ok: true, path: resolve(file), lanes: Object.keys(parsed.document.lanes) }, null, 2)}\n`);
      return;
    }

    if (cmd === "write") {
      const scopeIdx = argv.indexOf("--scope");
      const scope = scopeIdx !== -1 ? argv[scopeIdx + 1] : null;
      if (scope !== "global" && scope !== "project") fail("--scope must be global or project");
      const file = argv.filter((a, i) => {
        if (a.startsWith("--")) return false;
        if (i > 0 && (argv[i - 1] === "--cwd" || argv[i - 1] === "--scope")) return false;
        return i > 0;
      }).at(-1);
      if (!file) fail("write needs a JSON file path");
      const target =
        scope === "global" ? globalConfigPath() : projectConfigPath(cwd);
      if (!target) fail("project scope requires a git repository (--cwd)");
      const parsed = parseConfigDocument(readFileSync(resolve(file), "utf8"), file);
      if (!parsed.ok) fail(parsed.error);
      writeAtomic(target, parsed.document);
      process.stdout.write(`${JSON.stringify({ ok: true, path: target, lanes: Object.keys(parsed.document.lanes) }, null, 2)}\n`);
      return;
    }

    fail(`unknown command ${JSON.stringify(cmd)}. Use --help.`);
  } catch (error) {
    fail(error.message || String(error));
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2));
