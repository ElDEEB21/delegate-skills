#!/usr/bin/env node
/**
 * delegate-skills · pi-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Pi coding agent CLI (`pi --mode json`),
 * capture the JSON event stream, and write a structured result the orchestrating
 * agent can review. The orchestrator runs this one command and reads the result
 * JSON — every pi-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified against pi 0.82.1 on macOS.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `pi` and `git`, plus the platform
 * process-termination utility when a Windows process-tree kill requires one.
 * The `pi` process it launches does authenticate — exactly as you do at the
 * terminal. Read this file before you run it.
 *
 * The brief is piped to pi on stdin, so it never appears in the host process
 * list and no argv size cap applies. Keep secrets out of the brief anyway on
 * shared machines — reference workspace files or environment variables instead.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * — after it reviews the diff and re-runs the project gates.
 *
 * Autonomy: pi has no sandbox and no permission modes — a default headless run
 * reads, writes, edits, and runs shell commands without asking. `--read-only`
 * restricts pi to its read-only tool surface (`--tools read,grep,find,ls`), an
 * allowlist pi enforces across built-in, extension, and custom tools. The relay
 * never passes `--approve`, so project `.pi` resources stay untrusted. The diff
 * reported in `touchedFiles` is the record of what changed.
 *
 * pi is installed from npm, so on native Windows `pi` is a `.cmd` shim this
 * relay launches with shell:true. Only token-validated flag values ride argv
 * (the brief never does), which keeps that launch safe.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for pi (default: current directory).
 *   --model <pattern>       pi model id or pattern (default: pi's own default).
 *                           Letters, digits, and . _ : / - only.
 *   --session <id>          Resume a specific pi session; send only the delta brief.
 *   --resume-last           Continue the most recent pi session for this cwd
 *                           (`pi --continue`); send only the delta brief.
 *   --read-only             Restrict pi to read,grep,find,ls (no write/edit/bash).
 *   --timeout <dur>         Relay-side watchdog (default: 30m). pi has no timeout
 *                           flag; durations use h/m/s strings.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, piVersion, sessionId, finalMessage (pi's own
 *   report), touchedFiles (git porcelain, null if git cannot report), readOnly,
 *   and paths to brief.txt, final.txt, events.jsonl, and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `pi` binary exits 127;
 * otherwise the exit code mirrors pi's own (0 success, non-zero failure). If
 * the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal. Once the brief validates, `result.json` is
 * written on every outcome — completed, failed, timeout (the --timeout watchdog
 * fired, or the bounded --version preflight hung), aborted (the relay itself
 * was killed and forwarded the kill to pi), or pi_unavailable.
 */

import { spawn, execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, basename } from "node:path";
import { constants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TIMEOUT = "30m";
const VERSION_TIMEOUT_MS = 10_000;
const READ_ONLY_TOOLS = "read,grep,find,ls";
// --model and --session values reach a shell on win32 (shell:true for the
// .cmd shim), so they are restricted to safe tokens.
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseDuration(duration) {
  // Whole-string match: "1mtypo" must be rejected, not read as one minute.
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  return (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000;
}

function parseArgs(argv) {
  const opts = {
    brief: null,
    cd: process.cwd(),
    model: null,
    session: null,
    resumeLast: false,
    readOnly: false,
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
      case "--session": opts.session = next(); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--read-only": opts.readOnly = true; break;
      case "--timeout": opts.timeout = next(); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive; pass only one");
  }
  for (const flag of ["model", "session"]) {
    if (opts[flag] !== null && !SAFE_TOKEN.test(opts[flag])) {
      fail(`--${flag} value contains unsupported characters (allowed: letters, digits, . _ : / -)`);
    }
  }
  if (parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is not a duration; use h/m/s strings like 30m, 90s, or 1h30m`);
  }
  if (parseDuration(opts.timeout) === 0) fail("--timeout must be greater than zero");
  // setTimeout overflows past 2^31 - 1 ms (~24.8 days) and fires immediately,
  // which would read as an instant spurious timeout — reject it up front.
  if (parseDuration(opts.timeout) > 2_147_483_647) {
    fail(`--timeout "${opts.timeout}" exceeds the maximum schedulable watchdog (~24.8 days)`);
  }
  if (!existsSync(opts.cd) || !statSync(opts.cd).isDirectory()) {
    fail(`working directory not found: ${opts.cd}`);
  }
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs - dispatch a brief to pi --mode json\n";
  return `${match[1].replace(/^\s*\* ?/gm, "").trim()}\n`;
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
  }
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function killChild(child, signal = "SIGTERM") {
  // The kill must reach the whole process family, not just the CLI — a tool subprocess left
  // running would keep editing after the relay reports timeout/aborted. On Windows Node can't
  // kill a process family without a Job Object, so kill the tree by pid with the OS tool
  // (/t includes descendants, /f forces it — the tree-kill/npm idiom).
  if (process.platform === "win32") {
    if (signal !== "SIGTERM") return; // the first taskkill /f already felled the whole tree
    // stderr is inherited so a real taskkill failure (e.g. access denied) is visible to the operator;
    // its non-zero exit when the tree is already gone is the expected race and carries nothing to do.
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: ["ignore", "ignore", "inherit"] }); }
    catch { /* already gone — nothing left to kill */ }
  } else {
    // On POSIX the child leads its own process group (the detached launch), so the negative-pid
    // signal reaches every descendant; fall back to the lone pid if the group is already gone.
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
  }
}

function piVersion(timeoutMs) {
  // Bounded preflight: a hung or crashing CLI must not hang the relay or
  // masquerade as exit 127. Only a missing binary means "unavailable".
  if (process.platform === "win32") {
    // The probe below runs through a shell on win32 (the .cmd shim), and
    // cmd.exe reports a missing binary as exit 1 — not ENOENT — so ask
    // where.exe first to keep "not installed" classified as pi_unavailable.
    // where.exe ships in System32 on every supported Windows; a non-ENOENT
    // failure from it means it ran and found no pi on PATH.
    try {
      execFileSync("where.exe", ["pi"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch (whereError) {
      if (!whereError || whereError.code !== "ENOENT") return { version: null, error: null };
      // where.exe itself missing is practically impossible; fall through to
      // the normal probe rather than guess.
    }
  }
  try {
    return {
      version: execFileSync("pi", ["--version"], {
        encoding: "utf8",
        shell: process.platform === "win32", // resolve the pi.cmd shim
        timeout: Math.min(timeoutMs, VERSION_TIMEOUT_MS),
        killSignal: "SIGKILL",
      }).trim() || "unknown",
      error: null,
    };
  } catch (error) {
    if (error && error.code === "ENOENT") return { version: null, error: null };
    return { version: null, error };
  }
}

function gitTouchedFiles(cwd) {
  // null (not []) when git cannot report — git missing, or a non-repo run — so
  // the caller can tell "git unavailable" apart from "pi changed nothing."
  // [] means git ran and the working tree is clean.
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildArgv(opts) {
  // The brief rides stdin, never argv. --mode json alone is non-interactive:
  // pi reads the piped prompt, streams events, and exits.
  const argv = ["--mode", "json"];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.session) argv.push("--session", opts.session);
  else if (opts.resumeLast) argv.push("--continue");
  if (opts.readOnly) argv.push("--tools", READ_ONLY_TOOLS);
  return argv;
}

function makeEventScanner(onObject) {
  // pi documents --mode json as newline-delimited JSON. This brace-aware
  // scanner also tolerates chunk-split and concatenated objects plus non-JSON
  // progress text without depending on documented event boundaries.
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
          try { onObject(JSON.parse(slice)); } catch { /* ignore non-event text */ }
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
  // A reused --out-dir must not leak a previous run's artifacts into this one.
  rmSync(run.finalPath, { force: true });
  rmSync(run.resultPath, { force: true });
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
    // Atomic write: a polling orchestrator never reads a half-written result.
    const temporary = `${run.resultPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    renameSync(temporary, run.resultPath);
    return result;
  };
}

function reportUnavailable(writeResult, resultPath) {
  const result = writeResult({
    status: "pi_unavailable",
    exitCode: 127,
    signal: null,
    sessionId: null,
    finalMessage: "",
    touchedFiles: null,
  });
  printSummary(result, resultPath);
  process.stderr.write("relay: `pi` not found on PATH. Install with `npm install -g @earendil-works/pi-coding-agent`, then authenticate (`/login`, or an API-key environment variable).\n");
  process.exit(127);
}

function reportVersionFailure(writeResult, run, error, timeoutMs) {
  const timedOut = error && error.code === "ETIMEDOUT";
  const stderr = String((error && error.stderr) || "").trim();
  if (stderr) writeFileSync(run.stderrPath, `${stderr}\n`, "utf8");
  const message = timedOut
    ? `pi --version preflight timed out after ${Math.min(timeoutMs, VERSION_TIMEOUT_MS)}ms; pi was not dispatched`
    : `pi --version preflight failed${Number.isInteger(error && error.status) ? ` with exit ${error.status}` : ""}; pi was not dispatched`;
  const result = writeResult({
    status: timedOut ? "timeout" : "failed",
    exitCode: timedOut ? 124 : Number.isInteger(error && error.status) ? error.status : 1,
    signal: null,
    sessionId: null,
    finalMessage: "",
    touchedFiles: null,
    ...(stderr ? { stderrTail: stderr.split("\n").slice(-20) } : {}),
    error: message,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function dispatchToPi(opts, brief, run, writeResult) {
  const child = spawn("pi", buildArgv(opts), {
    cwd: opts.cd,
    stdio: ["pipe", "pipe", "pipe"],
    // shell:true on win32 so the pi.cmd shim resolves. Safe: the brief is fed
    // via stdin — never argv — and argv holds only the fixed flag names and
    // token-validated --model/--session values.
    shell: process.platform === "win32",
    detached: process.platform !== "win32", // POSIX: lead a new process group so killChild can fell the whole tree
  });

  let sessionId = null;
  const textChunks = [];
  const stderrTail = [];
  const scan = makeEventScanner((event) => {
    if (event.type === "session" && typeof event.id === "string") {
      sessionId = event.id;
    }
    if (event.type === "message_end" && event.message && event.message.role === "assistant") {
      const content = event.message.content;
      if (typeof content === "string") textChunks.push(content);
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part && part.type === "text" && typeof part.text === "string") textChunks.push(part.text);
        }
      }
    }
  });

  // Decode across chunk boundaries: a multibyte UTF-8 character split between
  // two data events would otherwise decode as U+FFFD and corrupt the report.
  // Files get the raw bytes; only in-memory parsing goes through the decoders.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk) => {
    appendFileSync(run.eventsPath, chunk);
    scan(stdoutDecoder.write(chunk));
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    appendFileSync(run.stderrPath, chunk);
    const text = stderrDecoder.write(chunk);
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  // A fast-exiting pi (usage error, crashed startup) closes the pipe before
  // the write; swallow EPIPE here — the exit code reports the failure.
  child.stdin.on("error", () => {});
  child.stdin.write(brief);
  child.stdin.end();

  const assembleFinal = () => {
    const message = textChunks.join("\n\n");
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  let settled = false;
  let watchdogFired = false;
  let sigkillTimer = null;
  const timeoutMs = parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT);
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
  }, timeoutMs);

  const clearWatchdog = () => {
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
  };

  // The relay's own death must still produce a result: without this, a kill from the
  // orchestrator's side (its command timeout, a stopped task, a closed terminal) writes
  // no result.json and leaves the pi child running or dying mid-edit with nothing
  // recording why. SIGTERM/SIGHUP registration is a no-op on Windows; SIGINT works there.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      const abortedFields = {
        status: "aborted",
        exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig,
        sessionId,
        finalMessage: assembleFinal(),
        touchedFiles: gitTouchedFiles(opts.cd),
        stderrTail: stderrTail.slice(-20),
        error: `the relay was killed by ${sig}; pi was terminated with it — inspect the working tree before re-dispatching`,
      };
      const result = writeResult(abortedFields);
      printSummary(result, run.resultPath);
      killChild(child);
      setTimeout(() => {
        killChild(child, "SIGKILL");
        // the child may flush files during the grace window; refresh the snapshot so the
        // artifact matches the tree the orchestrator will actually find
        writeResult({ ...abortedFields, touchedFiles: gitTouchedFiles(opts.cd) });
        process.exit(result.exitCode);
      }, 2000);
    });
  }

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      sessionId,
      finalMessage: assembleFinal(),
      touchedFiles: gitTouchedFiles(opts.cd),
      error: String(err && err.message ? err.message : err),
    });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    // a descendant that ignored SIGTERM must not outlive the timeout report: once the
    // parent is down, sweep the group (no-op where taskkill already felled the tree)
    if (watchdogFired) killChild(child, "SIGKILL");
    // A timed-out run is failed even if pi handles SIGTERM by exiting 0 —
    // orchestrators key off status and the relay exit code.
    const succeeded = code === 0 && !watchdogFired;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    const result = writeResult({
      status: succeeded ? "completed" : watchdogFired ? "timeout" : "failed",
      exitCode,
      signal: signal ?? null,
      sessionId,
      finalMessage: assembleFinal(),
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(watchdogFired ? { error: `pi did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` } : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  const timeoutMs = parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT);
  const run = prepareRunDir(opts, brief);
  const probe = piVersion(timeoutMs);
  const writeResult = makeResultWriter(opts, probe.version, run);
  if (!probe.version && !probe.error) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }
  if (!probe.version) {
    reportVersionFailure(writeResult, run, probe.error, timeoutMs);
    return;
  }
  dispatchToPi(opts, brief, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  pi ${result.piVersion ?? "?"}`);
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a pi error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: something outside the relay terminated pi (a supervisor, the session ending, or a manual kill) — when the relay itself does the killing it reports status \"timeout\" or \"aborted\" instead; inspect the working tree before re-dispatching.");
  if (result.readOnly) lines.push(`mode: read-only (tools ${READ_ONLY_TOOLS})`);
  if (result.resumed) lines.push("mode: resumed an existing session");
  if (result.sessionId) lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
  const touched = result.touchedFiles;
  if (touched === null) {
    lines.push("touched files: git unavailable - inspect the working tree directly");
  } else {
    lines.push(`touched files: ${touched.length}`);
    for (const file of touched.slice(0, 40)) lines.push(`  ${file}`);
    if (touched.length > 40) lines.push(`  ... and ${touched.length - 40} more`);
  }
  if (result.stderrTail && result.stderrTail.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push("--- pi final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
