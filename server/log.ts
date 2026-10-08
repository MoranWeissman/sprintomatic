/**
 * The error log at ~/.sprintomatic/logs/error.log.
 *
 * Most of this tool swallows errors on purpose: a lookup that fails becomes a
 * note, a backup that fails is ignored so the tool still starts. Those choices
 * are right — the user should not be stopped by a hiccup. But until now the
 * swallowed error vanished completely, so when something went wrong the user
 * had nothing to show anyone.
 *
 * This writes it down. One line per error, so `tail` and `grep` are enough to
 * read it. That is the whole feature: no levels, no transports, no config.
 *
 * Three promises this file has to keep:
 *  - it never throws. A logger that breaks the thing it is logging is worse
 *    than no logger, so every step is wrapped and failure is silent.
 *  - it never fills the disk. One line is capped, the file is capped, and only
 *    one old file is kept.
 *  - it never writes a secret. The tool holds an Azure DevOps personal access
 *    token, and tokens turn up inside error messages and headers, so the
 *    message, the stack and the extra fields are all cleaned first.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Roll the file over at 1 MB. An error line is at most a couple of kilobytes
 * (LINE_CAP below), so 1 MB holds thousands of errors — months of history for a
 * one-person tool — while staying small enough to open in any editor and send
 * to someone. With one old file kept, the most this can ever use is about 2 MB.
 */
const MAX_BYTES = 1024 * 1024;

/** No single error may write more than this, however huge the response body was. */
const LINE_CAP = 4000;

export interface LogErrorOptions {
  /** Where to write. Default: ~/.sprintomatic/logs. Tests pass a temp folder. */
  dir?: string;
  /** Clock, injected by tests. */
  now?: Date;
  /** Roll the file over above this many bytes. Default: 1 MB. */
  maxBytes?: number;
}

function defaultLogDir(): string {
  return join(homedir(), '.sprintomatic', 'logs');
}

/**
 * Write one error down. `where` is a short label saying which piece of code hit
 * it (e.g. 'ado-client.runAz'), `extra` is anything else worth knowing.
 * Never throws, whatever happens.
 */
export function logError(
  where: string,
  err: unknown,
  extra?: Record<string, unknown>,
  opts: LogErrorOptions = {},
): void {
  try {
    // Under the test runner, only write where a test explicitly asked us to.
    // Code paths that call this without a folder (ado-client, db) would
    // otherwise fill the user's real log with made-up errors from fixtures.
    if (process.env.VITEST && !opts.dir) return;

    const dir = opts.dir ?? defaultLogDir();
    const now = opts.now ?? new Date();
    const maxBytes = opts.maxBytes ?? MAX_BYTES;

    const line = buildLine(where, err, extra, now);

    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'error.log');
    rotateIfFull(file, line.length, maxBytes);
    appendFileSync(file, line, 'utf8');
  } catch {
    // Deliberately silent. Logging must never become the failure.
  }
}

/* ------------------------------------------------------------------ */
/*  The line                                                           */
/* ------------------------------------------------------------------ */

function buildLine(
  where: string,
  err: unknown,
  extra: Record<string, unknown> | undefined,
  now: Date,
): string {
  const parts = [`${isoOrUnknown(now)} [${redact(flatten(String(where)))}]`, redact(messageOf(err))];

  const fields = extraFields(extra);
  if (fields) parts.push(`| ${fields}`);

  const stack = stackOf(err);
  if (stack) parts.push(`| stack ${redact(stack)}`);

  const line = parts.join(' ');
  const capped = line.length > LINE_CAP ? `${line.slice(0, LINE_CAP)} …(cut short)` : line;
  return `${capped}\n`;
}

function isoOrUnknown(now: Date): string {
  try {
    return now.toISOString();
  } catch {
    return 'unknown-time';
  }
}

/** The error's message, whatever kind of thing was thrown. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return flatten(err.message || err.name || 'Error');
  if (typeof err === 'string') return flatten(err);
  if (err === null) return 'null';
  if (err === undefined) return 'undefined';
  if (typeof err === 'object') {
    const maybe = (err as { message?: unknown }).message;
    if (typeof maybe === 'string' && maybe) return flatten(maybe);
    return flatten(safeJson(err));
  }
  return flatten(String(err));
}

function stackOf(err: unknown): string {
  const raw = err instanceof Error ? err.stack : undefined;
  return raw ? flatten(raw) : '';
}

/** Render the extra fields as `key=value`, cleaned, on the same one line. */
function extraFields(extra: Record<string, unknown> | undefined): string {
  if (!extra || typeof extra !== 'object') return '';
  const out: string[] = [];
  for (const [key, value] of Object.entries(extra)) {
    const clean = looksSecret(key) ? REDACTED : redact(flatten(stringify(value)));
    out.push(`${redact(flatten(key))}=${clean}`);
  }
  return out.join(' ');
}

function stringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return safeJson(value);
  return String(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular, or something that refuses to be turned into text.
    return '[unprintable]';
  }
}

/** Everything goes on one line, so line breaks become a visible marker. */
function flatten(text: string): string {
  return text.replace(/\r?\n\s*/g, ' \\n ');
}

/* ------------------------------------------------------------------ */
/*  Keeping secrets out                                                */
/* ------------------------------------------------------------------ */

const REDACTED = '[redacted]';

/** Field and header names that carry a secret by their very name. */
const SECRET_NAME = /(token|pat|secret|password|passwd|credential|authorization|auth|api[-_]?key|\bkey\b)/i;

function looksSecret(key: string): boolean {
  return SECRET_NAME.test(key);
}

/**
 * Strip anything that could be a secret out of a piece of text.
 *
 * Three passes, in this order:
 *  1. a header or a field named like a secret — `Authorization: …`, `pat=…`,
 *     `"token": "…"` — loses its value, keeps its name.
 *  2. the word Bearer or Basic followed by a value loses the value.
 *  3. any long unbroken run of token-shaped characters is dropped, because an
 *     Azure DevOps personal access token is exactly that and it turns up bare
 *     in messages. A long hash or a base64 blob gets dropped too; that costs
 *     nothing, and guessing wrong the other way costs a token.
 */
function redact(text: string): string {
  if (!text) return text;
  let out = text;

  // 1. named header / field / json key, with :, = or => between name and value.
  out = out.replace(
    /((?:authorization|auth|token|pat|secret|password|passwd|credential|api[-_]?key)"?\s*(?::|=>|=)\s*"?)([^\s",;)}\]]+)/gi,
    (_m, name: string) => `${name}${REDACTED}`,
  );

  // 2. a bearer or basic value anywhere, even without a header name in front.
  out = out.replace(/\b(Bearer|Basic)\s+[^\s",;)}\]]+/gi, (_m, scheme: string) => `${scheme} ${REDACTED}`);

  // 3. a bare token-shaped run. Azure DevOps personal access tokens are 52
  //    characters; 32 is a safe floor that no ordinary word reaches. A slash is
  //    left out of the run on purpose, so a long file path or URL stays
  //    readable in the stack instead of turning into one big [redacted].
  out = out.replace(/[A-Za-z0-9_\-+=]{32,}/g, REDACTED);

  return out;
}

/* ------------------------------------------------------------------ */
/*  Keeping the file small                                             */
/* ------------------------------------------------------------------ */

/**
 * Roll `error.log` away to `error.log.1` once the next line would push it past
 * the cap. Only one old file is kept — the previous `error.log.1` is replaced,
 * so this can never grow into a pile of dated files.
 */
function rotateIfFull(file: string, incomingBytes: number, maxBytes: number): void {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return; // No file yet — nothing to roll away.
  }
  if (size + incomingBytes <= maxBytes) return;
  try {
    renameSync(file, `${file}.1`);
  } catch {
    // Could not roll it away; the append below still works, so carry on.
  }
}
