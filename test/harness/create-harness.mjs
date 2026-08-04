import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { EXTRA_ARGS, SKILLS, WIN, relayPath } from "./constants.mjs";

const harnessDir = dirname(fileURLToPath(import.meta.url));
export const testDir = join(harnessDir, "..");

export function createHarness() {
  let failed = 0;
  const check = (name, cond) => {
    console.log(`${cond ? "  ok " : "  FAIL"}  ${name}`);
    if (!cond) failed++;
  };
  const pair = (args, flag, value) => args[args.indexOf(flag) + 1] === value;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return true;
      await sleep(250);
    }
    return fn();
  };
  const alive = (pid) => {
    try { process.kill(pid, 0); } catch { return false; }
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = /\)\s+(\S)/.exec(stat.slice(stat.lastIndexOf(")")));
      return state ? state[1] !== "Z" : true;
    } catch {
      return true;
    }
  };

  const scratch = mkdtempSync(join(tmpdir(), "relay-smoke-"));

  const h = {
    check,
    get failed() { return failed; },
    pair,
    sleep,
    until,
    alive,
    SKILLS,
    EXTRA_ARGS,
    WIN,
    testDir,
    scratch,
    relayPath: (skill) => relayPath(testDir, skill),
    briefPath: null,
    baseEnv: null,
    slowWriteNodeOptions: null,
    freshRepo: null,
    runRelay: null,
    result: null,
    cleanup() {
      rmSync(scratch, { recursive: true, force: true });
    },
  };

  h.freshRepo = (name) => {
    const dir = join(scratch, name);
    mkdirSync(dir);
    spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" });
    return dir;
  };

  h.runRelay = (skill, workDir, outDir, extraArgs, extraEnv) =>
    spawn(process.execPath, [h.relayPath(skill), "--brief", h.briefPath, "--cd", workDir, "--out-dir", outDir, ...extraArgs], {
      env: { ...h.baseEnv, ...extraEnv },
      stdio: ["ignore", "ignore", "pipe"],
    });

  h.result = (outDir) => JSON.parse(readFileSync(join(outDir, "result.json"), "utf8"));

  return h;
}
