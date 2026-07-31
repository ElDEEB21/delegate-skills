// delegate-skills · lib/event-scanner.mjs
//
// Shared stream parsers for relay scripts.  Two exports:
//   makeEventScanner — brace-aware JSON object extractor; tolerates NDJSON,
//                      junk prefixes, concatenated objects, and arbitrary chunk
//                      boundaries while respecting JSON strings and escapes.
//   makeLineScanner  — newline-delimited JSON line parser; tolerates blank
//                      lines and non-JSON gracefully.
//
// Node built-ins only.  Not executable — imported by relay scripts.

// Retained partial input is capped so a malformed or non-JSON stream (e.g. an
// implementer that spews unterminated junk) cannot grow memory without bound.
// When the cap is exceeded the scanner drops the retained tail and resets, so a
// later valid event still parses.
const MAX_BUFFERED_CHARS = 1_048_576;

/**
 * Create a streaming JSON-object scanner.
 *
 * The returned function accepts string chunks (typically from a StringDecoder
 * fed by a child process's stdout).  For every complete top-level `{...}` it
 * closes, it calls `onObject(parsed)` with the result of `JSON.parse`.
 *
 * Robust to:
 *  - NDJSON (one object per line)
 *  - junk prefixes (e.g. terminal-notify escape sequences before the `{`)
 *  - concatenated objects on the same line
 *  - objects split across chunk boundaries
 *  - braces and quotes inside JSON string values (including backslash escapes)
 *
 * At the end of each call the scanner retains only the in-progress object (if
 * any) and resets all parse state.  The next call re-derives depth, string, and
 * escape state by scanning the retained prefix from scratch — this prevents a
 * carried-over depth from double-counting retained braces.  The cost is O(n²)
 * if a single object spans many chunks (each re-scans the retained prefix);
 * this is fine for implementer event sizes.  Retained input is bounded by
 * `MAX_BUFFERED_CHARS`; oversized partial input is dropped and the scanner
 * resets, so a later valid event still parses.
 *
 * @param {(obj: unknown) => void} onObject
 * @returns {(chunk: string) => void}
 */
export function makeEventScanner(onObject) {
  let buf = "";
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  return (chunk) => {
    if (!chunk) return;
    buf += chunk;
    if (buf.length > MAX_BUFFERED_CHARS) {
      // Unterminated or malformed tail that will never close; drop it and reset
      // so the next chunk starts a fresh scan.
      buf = "";
      depth = 0;
      start = -1;
      inString = false;
      escaped = false;
      return;
    }
    for (let i = 0; i < buf.length; i += 1) {
      const ch = buf[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      // Only track strings inside an object (depth > 0).  At depth 0 we are
      // skipping a junk prefix, and an unmatched `"` there must not swallow the
      // real `{...}` that follows in the same chunk.
      if (ch === '"') { if (depth > 0) inString = true; continue; }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}") {
        if (depth > 0) {
          depth -= 1;
          if (depth === 0 && start !== -1) {
            const slice = buf.slice(start, i + 1);
            try { onObject(JSON.parse(slice)); } catch { /* skip malformed */ }
            start = -1;
          }
        }
      }
    }
    // Retain only an in-progress object (if any) so the buffer cannot grow
    // without bound; everything already emitted or skipped is dropped.  Reset
    // the scanner state: the next call re-derives depth/string/escape by
    // scanning the retained prefix (which always begins at an object's `{`)
    // from scratch.
    buf = depth > 0 && start !== -1 ? buf.slice(start) : "";
    start = -1;
    depth = 0;
    inString = false;
    escaped = false;
  };
}

/**
 * Create a newline-delimited JSON line scanner.
 *
 * The returned function accepts string chunks and calls `onObject(parsed)` for
 * every non-blank line that parses as JSON.  Lines that are not valid JSON are
 * silently skipped.  Empty chunks are ignored, and retained partial input is
 * bounded by `MAX_BUFFERED_CHARS`; an unterminated line that exceeds the cap is
 * dropped so a later valid line still parses.
 *
 * @param {(obj: unknown) => void} onObject
 * @returns {(chunk: string) => void}
 */
export function makeLineScanner(onObject) {
  let buf = "";
  return (chunk) => {
    if (!chunk) return;
    buf += chunk;
    if (buf.length > MAX_BUFFERED_CHARS) {
      buf = "";
      return;
    }
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { onObject(JSON.parse(trimmed)); } catch { /* skip non-JSON lines */ }
    }
  };
}
