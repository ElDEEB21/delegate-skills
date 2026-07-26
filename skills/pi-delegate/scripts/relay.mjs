#!/usr/bin/env node
/**
 * delegate-skills · pi-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the pi CLI (`pi -p`), capture the
 * structured event stream from `--mode json`, and write a result the
 * orchestrator can review. The relay uses Node built-ins only and shells out
 * only to `pi`, `git`, and the platform process-termination utility when
 * needed. It makes no network calls, reads no credentials, sends no telemetry,
 * and never commits.
 *
 * The brief is passed as a command-line argument (`-p <brief>`). Keep secrets
 * out of the brief on shared hosts; point pi at workspace files or environment
 * variables instead.
 *
 * pi launches with the shell disabled on POSIX. On Windows the relay resolves
 * `pi` on PATH and, when it finds a `.cmd` shim, serializes arguments through
 * `cmd /d /v:off /s /c` with explicit `%` and `"` escaping, avoiding cmd.exe's
 * implicit `%VAR%` expansion and `!` delayed expansion.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Brief path. If omitted, read stdin.
 *   --cd <dir>              pi working root (default: current directory).
 *   --model <pattern>       Model pattern or provider/id (e.g. `gpt-4o`,
 *                           `github/gpt-4o`, `sonnet:high`).
 *   --provider <name>       Provider name (default: pi's configured default).
 *   --read-only             Add --tools read,grep,find,ls to restrict pi's
 *                           tool surface (read-only mode).
 *   --session <id>          Resume a specific pi session; send only the delta
 *                           brief.
 *   --resume-last           Continue the most recent pi session; send only the
 *                           delta brief.
 *   --approve               Trust project-local files (default).
 *   --no-approve            Ignore project-local files for this run.
 *   --timeout <dur>         Relay watchdog (default: 30m). pi has no timeout
 *                           flag of its own; durations use h/m/s strings.
 *   --out-dir <dir>         Artifact directory (default: system temp).
 *   -h, --help              Show this help.
 *
 * Result: <out-dir>/result.json plus brief.txt, events.jsonl, stderr.txt, and
 * final.txt when pi emits a final message. Pre-run usage errors exit 2 and
 * write no result. Missing `pi` exits 127 with pi_unavailable. Once
 * dispatched, every outcome writes a result: completed, failed, timeout,
 * aborted, or pi_unavailable.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants, tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TIMEOUT = "30m";
const MAX_BRIEF_BYTES = (process.platform === "win32" ? 12 : 120) * 1024;

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseDuration(duration) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  return (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000;
}

function parseArgs(argv) {
  const opts = {
    brief: null,
    cd: process.cwd(),
    model: null,
    provider: null,
    readOnly: false,
    session: null,
    resumeLast: false,
    approve: true,
    timeout: DEFAULT_TIMEOUT,
    outDir: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(headerComment());
        process.exit(0);
        break;
      case "--brief": opts.brief = next(); break;
      case "--cd": opts.cd = resolve(next()); break;
      case "--model": opts.model = next(); break;
      case "--provider": opts.provider = next(); break;
      case "--read-only": opts.readOnly = true; break;
      case "--session": opts.session = next(); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--approve": opts.approve = true; break;
      case "--no-approve": opts.approve = false; break;
      case "--timeout": opts.timeout = next(); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default: fail(`unknown option: ${arg}`);
    }
  }

  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive; pass only one");
  }
  if (opts.model !== null && !opts.model.trim()) fail("--model must not be empty");
  if (opts.provider !== null && !opts.provider.trim()) fail("--provider must not be empty");
  if (opts.session !== null && !opts.session.trim()) fail("--session must not be empty");
  if (parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is not a duration; use h/m/s strings like 30m, 90s, or 1h30m`);
  }

  return opts;
}

function headerComment() {
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const match = source.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs - dispatch a brief to pi -p\n";
  return `${match[1].replace(/^\s*\* ?/gm, "").trim()}\n`;
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe stdin");
  }
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function killChild(child, signal = "SIGTERM") {
  if (process.platform === "win32") {
    if (signal !== "SIGTERM") return;
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch { /* The tree already exited. */ }
  } else {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* The tree already exited. */ }
    }
  }
}

function piVersion(launcher) {
  if (!launcher) return null;
  try {
    const spec = launchSpec(launcher, ["--version"]);
    const out = execFileSync(spec.command, spec.argv, {
      encoding: "utf8",
      timeout: 10_000,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    }).trim();
    return out || "unknown";
  } catch (err) {
    return "unknown";
  }
}

function resolvePiLauncher() {
  if (process.platform !== "win32") {
    const checked = {};
    const pathValue = process.env.PATH || "";
    for (const entry of pathValue.split(delimiter)) {
      const dir = resolve(entry || ".");
      if (checked[dir]) continue;
      checked[dir] = true;
      const candidate = join(dir, "pi");
      try {
        accessSync(candidate, fsConstants.X_OK);
        if (statSync(candidate).isFile()) return { path: candidate, kind: "direct" };
      } catch { /* keep searching */ }
    }
    return null;
  }

  const pathExt = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const pathValue = process.env.PATH || "";
  const checked = {};
  for (const entry of pathValue.split(delimiter)) {
    const dir = resolve(entry || ".");
    if (checked[dir]) continue;
    checked[dir] = true;
    for (const ext of pathExt) {
      const candidate = join(dir, `pi${ext}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        const kind = ext === ".cmd" || ext === ".bat" ? "cmd" : "direct";
        return { path: candidate, kind };
      } catch { /* keep searching */ }
    }
  }
  return null;
}

function escapeCmdArg(value) {
  // cmd.exe expands %VAR% inside quoted strings and treats "" as a literal
  // quote. Null bytes cannot be represented. All other characters are safe
  // between the outer quotes when /v:off disables delayed ! expansion.
  if (value.indexOf("\0") !== -1) {
    throw new Error("cannot pass a null byte through cmd.exe; ensure the brief and flags contain only printable text");
  }
  return `"${value.replace(/%/g, "%%").replace(/"/g, '""')}"`;
}

function launchSpec(launcher, argv) {
  if (launcher.kind === "direct") {
    return { command: launcher.path, argv, windowsVerbatimArguments: false };
  }
  // .cmd shim on Windows: serialize through cmd /d /v:off /s /c to avoid
  // %VAR% expansion, !delayed expansion, and auto-run commands.
  const commandLine = [launcher.path, ...argv].map(escapeCmdArg).join(" ");
  return {
    command: process.env.COMSPEC || "cmd.exe",
    argv: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

function gitTouchedFiles(cwd) {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return output.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildArgv(opts, brief) {
  const argv = ["--mode", "json"];
  if (opts.session) argv.push("--session-id", opts.session);
  else if (opts.resumeLast) argv.push("-c");
  if (opts.model) argv.push("--model", opts.model);
  if (opts.provider) argv.push("--provider", opts.provider);
  if (opts.approve) argv.push("--approve");
  if (opts.readOnly) argv.push("--tools", "read,grep,find,ls");
  argv.push("-p", brief);
  return argv;
}

function makeEventScanner(onObject) {
  let buffer = "";
  let cursor = 0;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  return (chunk) => {
    buffer += chunk;
    for (; cursor < buffer.length; cursor += 1) {
      const char = buffer[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        if (depth > 0) inString = true;
      } else if (char === "{") {
        if (depth === 0) start = cursor;
        depth += 1;
      } else if (char === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          const slice = buffer.slice(start, cursor + 1);
          try { onObject(JSON.parse(slice)); } catch { /* Ignore non-event text. */ }
          buffer = buffer.slice(cursor + 1);
          cursor = -1;
          start = -1;
        }
      }
    }
    if (depth === 0) {
      buffer = "";
      cursor = 0;
      start = -1;
      inString = false;
      escaped = false;
    }
  };
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    briefPath: join(outDir, "brief.txt"),
    finalPath: join(outDir, "final.txt"),
    eventsPath: join(outDir, "events.jsonl"),
    stderrPath: join(outDir, "stderr.txt"),
    resultPath: join(outDir, "result.json"),
  };
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.eventsPath, "", "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  return run;
}

function makeResultWriter(opts, version, run) {
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      tool: "pi",
      workdir: opts.cd,
      model: opts.model,
      provider: opts.provider,
      readOnly: opts.readOnly,
      resumed: Boolean(opts.resumeLast || opts.session),
      piVersion: version,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      eventsPath: run.eventsPath,
      stderrPath: run.stderrPath,
      ...extra,
    };
    writeFileSync(run.resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  };
}

function reportUnavailable(writeResult, resultPath) {
  const result = writeResult({
    status: "pi_unavailable",
    exitCode: 127,
    signal: null,
    sessionId: null,
    usage: null,
    finalMessage: "",
    touchedFiles: null,
  });
  printSummary(result, resultPath);
  process.stderr.write("relay: `pi` not found on PATH. Install pi and authenticate with your provider.\n");
  process.exit(127);
}

function dispatch(opts, brief, launcher, run, writeResult) {
  const spec = launchSpec(launcher, buildArgv(opts, brief));
  const child = spawn(spec.command, spec.argv, {
    cwd: opts.cd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    detached: process.platform !== "win32",
  });

  let sessionId = null;
  let usage = null;
  let actualModel = null;
  let actualProvider = null;
  const textChunks = [];
  const stderrTail = [];

  const scan = makeEventScanner((event) => {
    // pi emits newline-delimited JSON events with shapes like:
    // {"event":"message_start","id":"<uuid>","message":{...}}
    // {"event":"message_end","id":"<uuid>","message":{"content":[{"type":"text","text":"..."}],"usage":{...},"model":"...","provider":"..."}}
    // {"event":"session","id":"<uuid>",...}
    // Only capture the sessionId from a session event — message_start/message_end
    // carry a message-level id, not the session UUID.
    if (event.event === "session" && typeof event.id === "string") {
      sessionId = event.id;
    }
    // message_end carries the finalized message object with model, provider,
    // usage, and the full assistant content. message_update also carries a
    // message but with incomplete content — ignore it.
    if (event.event === "message_end" && event.message && typeof event.message === "object") {
      if (Array.isArray(event.message.content)) {
        for (const block of event.message.content) {
          if (block?.type === "text" && typeof block.text === "string") {
            textChunks.push(block.text);
          }
        }
      }
      if (event.message.usage && typeof event.message.usage === "object") {
        usage = event.message.usage;
      }
      if (typeof event.message.model === "string") {
        actualModel = event.message.model;
      }
      if (typeof event.message.provider === "string") {
        actualProvider = event.message.provider;
      }
    }
  });

  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk) => {
    appendFileSync(run.eventsPath, chunk);
    scan(stdoutDecoder.write(chunk));
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    appendFileSync(run.stderrPath, chunk);
    for (const line of stderrDecoder.write(chunk).split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  const assembleFinal = () => {
    const message = textChunks.join("\n\n");
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  let settled = false;
  let watchdogFired = false;
  let sigkillTimer = null;
  const watchdogTimer = setTimeout(() => {
    watchdogFired = true;
    child.once("exit", () => {
      child.stdout.destroy();
      child.stderr.destroy();
    });
    killChild(child);
    sigkillTimer = setTimeout(() => {
      if (!settled) killChild(child, "SIGKILL");
    }, 10_000);
  }, parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT));

  const clearWatchdog = () => {
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
  };

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      const abortedFields = () => ({
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        sessionId,
        actualModel,
        actualProvider,
        usage,
        finalMessage: assembleFinal(),
        touchedFiles: gitTouchedFiles(opts.cd),
        stderrTail: stderrTail.slice(-20),
        error: `the relay was killed by ${sig}; pi was terminated with it — inspect the working tree before re-dispatching`,
      });
      const result = writeResult(abortedFields());
      printSummary(result, run.resultPath);
      killChild(child);
      setTimeout(() => {
        killChild(child, "SIGKILL");
        writeResult(abortedFields());
        process.exit(result.exitCode);
      }, 2000);
    });
  }

  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      sessionId,
      actualModel,
      actualProvider,
      usage,
      finalMessage: assembleFinal(),
      touchedFiles: gitTouchedFiles(opts.cd),
      stderrTail: stderrTail.slice(-20),
      error: String(error?.message || error),
    });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    if (watchdogFired) killChild(child, "SIGKILL");
    scan(stdoutDecoder.end());
    const stderrEnd = stderrDecoder.end();
    if (stderrEnd.trim()) stderrTail.push(stderrEnd.trimEnd());
    const succeeded = code === 0 && !watchdogFired;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode,
      signal: signal ?? null,
      sessionId,
      actualModel,
      actualProvider,
      usage,
      finalMessage: assembleFinal(),
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(watchdogFired ? { error: `pi did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` } : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(exitCode);
  });
}

function printSummary(result, resultPath) {
  const lines = [
    "",
    `relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""}) · pi ${result.piVersion ?? "?"}`,
  ];
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly an OOM killer or supervisor timeout) — check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated pi (a supervisor, the session ending, or a manual kill) — the relay itself reports timeout or aborted instead; inspect the working tree before re-dispatching.");
  if (result.resumed) lines.push("mode: resumed an existing session");
  if (result.actualModel) lines.push(`model: ${result.actualModel}`);
  if (result.actualProvider) lines.push(`provider: ${result.actualProvider}`);
  if (result.sessionId) lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
  if (result.touchedFiles === null) {
    lines.push("touched files: git unavailable - inspect the working tree directly");
  } else {
    lines.push(`touched files: ${result.touchedFiles.length}`);
    for (const file of result.touchedFiles.slice(0, 40)) lines.push(`  ${file}`);
    if (result.touchedFiles.length > 40) lines.push(`  ... and ${result.touchedFiles.length - 40} more`);
  }
  if (result.stderrTail?.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("", "--- pi final report ---", result.finalMessage || "(no final message captured)", "--- end report ---", "");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe stdin)");
  const briefBytes = Buffer.byteLength(brief, "utf8");
  if (briefBytes > MAX_BRIEF_BYTES) {
    fail(`brief is ${Math.round(briefBytes / 1024)}KB; keep large context in workspace files instead of argv`);
  }

  const launcher = resolvePiLauncher();
  const version = piVersion(launcher);
  const run = prepareRunDir(opts, brief);
  const writeResult = makeResultWriter(opts, version, run);
  if (!launcher || !version) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }
  dispatch(opts, brief, launcher, run, writeResult);
}

main();
