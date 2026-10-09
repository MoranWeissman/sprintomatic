/**
 * One place that turns an `az` failure into words a person can act on.
 *
 * The Azure CLI is a Python program. When it fails it prints an `ERROR:` line
 * and then, very often, a full Python traceback with file paths from inside
 * the CLI's own install. None of that helps the user, and pasting it into the
 * dashboard or a chat is what made these failures feel broken rather than
 * ordinary. The real reason is always one of a small number of things, and
 * each one has exactly one fix.
 *
 * So: the raw text goes to the log (it is the only place the details survive),
 * and what the user reads is a headline, one sentence, and the one thing to do.
 *
 * Pure: no database, no network, no imports.
 */

export type AzFailureKind =
  /** Signed out, or the sign-in expired. */
  | 'signed-out'
  /** Signed in, but the local sign-in cache file is damaged. */
  | 'cache-broken'
  /** The machine can't reach dev.azure.com at all. */
  | 'offline'
  /** The `az` program isn't installed, or isn't on the PATH. */
  | 'az-missing'
  /** Signed in, but `az` doesn't know which organization or project to use. */
  | 'not-configured'
  /** The call was still waiting when we gave up on it. */
  | 'timeout'
  /** The organization, project or team name doesn't match a real one. */
  | 'not-found'
  /** Something we don't have a rule for yet. */
  | 'other';

export interface AzFailure {
  kind: AzFailureKind;
  /** Short headline — what happened, in four or five words. */
  headline: string;
  /** One plain sentence about what happened. */
  message: string;
  /** The one thing to do about it. Null when we don't know what to suggest. */
  fix: string | null;
  /** Everything above as one line, for callers that only have room for text. */
  text: string;
}

/**
 * The first useful line of a CLI failure.
 *
 * We want the `ERROR:` line if there is one; a traceback is dropped whole. The
 * cap is there because some `ERROR:` lines carry a whole URL and a nested
 * Python exception, and by then the sentence has stopped being readable.
 */
function firstErrorLine(raw: string, max = 180): string {
  const lines = raw
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  const errLine = lines.find(l => l.startsWith('ERROR:')) ?? lines[0] ?? '';
  const cleaned = errLine.replace(/^ERROR:\s*/, '').trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

/**
 * Classify a failure from `az`.
 *
 * `raw` is whatever the process printed (stderr, or a message when there was
 * no stderr). `code` is the child-process error code when the caller has one —
 * `ENOENT` is the only way to tell "az isn't installed" apart from everything
 * else, because a missing program prints nothing at all.
 */
export function describeAzFailure(raw: string, code?: string): AzFailure {
  const text = String(raw ?? '');

  // Killed for taking too long. Checked before everything else because a killed
  // call has no stderr to classify.
  if (code === 'ETIMEDOUT') {
    return build(
      'timeout',
      'The board took too long to answer',
      'A board command was still waiting after a minute, so it was stopped — usually a network that half works.',
      'Try again. If it keeps happening, check your connection or the VPN.',
    );
  }

  // The program isn't there. stderr is empty in this case, so the code is all
  // we have to go on.
  if (code === 'ENOENT' || /command not found|no such file or directory/i.test(text)) {
    return build(
      'az-missing',
      "The Azure CLI isn't installed",
      "sprintomatic talks to your board through the `az` command, and that command isn't on this machine.",
      'Install the Azure CLI, then run `az login`.',
    );
  }

  // Signed in, but the CLI has no organization/project defaults. New machines
  // hit this, and it looks nothing like a sign-in problem — so don't say one.
  if (/must be specified|az devops configure|no default (organization|project)/i.test(text)) {
    return build(
      'not-configured',
      "The Azure CLI doesn't know your project",
      "sprintomatic reads which organization and project to use from the Azure CLI, and no default is set there.",
      'Run `az devops configure --defaults organization=https://dev.azure.com/YOUR-ORG project="YOUR PROJECT"`.',
    );
  }

  // No network. This one is NOT a sign-in problem, and saying "run az login"
  // here would send the user chasing the wrong thing — which is exactly what
  // the old raw traceback did.
  if (
    /NameResolutionError|Failed to resolve|Max retries exceeded|getaddrinfo|ENOTFOUND|EAI_AGAIN|Connection aborted|Read timed out|ConnectTimeout/i.test(
      text,
    )
  ) {
    return build(
      'offline',
      "Can't reach Azure DevOps",
      "This machine couldn't reach dev.azure.com — the network or the VPN is down, not your sign-in.",
      'Check your connection (and the VPN if you need one), then try again.',
    );
  }

  // The sign-in cache file is damaged: the CLI fails while READING it, which
  // surfaces as a JSON parse error deep inside msal. Signing in again rewrites
  // the file, so that is still the fix — but the user needs to know it isn't
  // just an expired sign-in, or a failed `az login` will be confusing.
  if (
    /Extra data: line|JSONDecodeError|Expecting value: line|token_cache|msal_token_cache/i.test(text)
  ) {
    return build(
      'cache-broken',
      'Your saved sign-in is damaged',
      "The file the Azure CLI keeps your sign-in in can't be read any more, so every board call fails.",
      'Run `az login` to write it fresh. If that also fails, delete `~/.azure/msal_token_cache.json` and run `az login` again.',
    );
  }

  // Signed out, or the sign-in ran out.
  if (
    /az login|az devops login|not logged in|does not exist in MSAL token cache|refresh token|AADSTS|expired|re-?authenticat|credential/i.test(
      text,
    )
  ) {
    return build(
      'signed-out',
      "You're signed out of Azure",
      "Your Azure sign-in isn't there, or it ran out, so sprintomatic can't read or change the board.",
      'Run `az login` — in a chat here you can type `! az login`.',
    );
  }

  // A name that doesn't match the board: wrong organization, project or team.
  if (/TF200016|TF400813|cannot be found|could not be found|\b404\b/i.test(text)) {
    return notFound();
  }

  const line = firstErrorLine(text);
  return build(
    'other',
    'A board command failed',
    line ? `The Azure CLI said: ${line}` : 'The Azure CLI failed without saying why.',
    null,
  );
}

function notFound(): AzFailure {
  return build(
    'not-found',
    "Couldn't find your board",
    "Couldn't find that organization, project or team. Check the names — they are in your board's web address.",
    'Run `npm run setup` again to fix them.',
  );
}

/**
 * The words for a failed call to the Azure DevOps web API (token mode).
 *
 * Same idea as `describeAzFailure`: the raw answer goes to the log, the user
 * reads a sentence. `body` is the answer's text; Azure DevOps usually sends
 * JSON with a `message` field.
 */
export function describeHttpFailure(status: number, body: string): AzFailure {
  let said = '';
  try {
    said = String((JSON.parse(body) as { message?: unknown }).message ?? '');
  } catch {
    said = '';
  }

  if (status === 401 || status === 403) {
    return build(
      'signed-out',
      'Azure DevOps turned down the token',
      'Azure DevOps turned down the stored token. It may be wrong, out of date, or missing the Work Items (Read & write) permission.',
      'Run `npm run setup` again to give it a new token.',
    );
  }

  if (status === 404) {
    // A task or story that is gone is a different thing from a wrong board
    // name, and Azure DevOps' own sentence for it is already readable.
    const item = /work item (\d+) does not exist/i.exec(said);
    if (item) {
      return build(
        'other',
        "Couldn't find that item",
        `Couldn't find #${item[1]} on the board. It may have been deleted, or you can't see it.`,
        null,
      );
    }
    return notFound();
  }

  const line = firstErrorLine(said || body);
  return build(
    'other',
    'A board call failed',
    line ? `Azure DevOps said (${status}): ${line}` : `Azure DevOps answered ${status} without saying why.`,
    null,
  );
}

function build(kind: AzFailureKind, headline: string, message: string, fix: string | null): AzFailure {
  return { kind, headline, message, fix, text: fix ? `${message} ${fix}` : message };
}

/** An Error carrying its classified failure, for callers that surface it. */
export interface AzError extends Error {
  command?: string;
  azKind: AzFailureKind;
  azHeadline: string;
  azMessage: string;
  azFix: string | null;
}

/**
 * Build the Error to throw for an `az` failure.
 *
 * `lead` is for a caller that needs to say what it was doing ("Couldn't read
 * your team…"); it goes in front of both the short message and the full text,
 * so the dashboard and a chat stay in step.
 */
export function azFailureError(
  raw: string,
  code?: string,
  opts?: { command?: string; lead?: string },
): AzError {
  return failureError(describeAzFailure(raw, code), opts);
}

/** Build the Error to throw for a failed web API call (token mode). */
export function httpFailureError(status: number, body: string): AzError {
  return failureError(describeHttpFailure(status, body));
}

function failureError(f: AzFailure, opts?: { command?: string; lead?: string }): AzError {
  const lead = opts?.lead ? `${opts.lead} ` : '';
  const err = new Error(`${lead}${f.text}`) as AzError;
  err.azKind = f.kind;
  err.azHeadline = f.headline;
  err.azMessage = `${lead}${f.message}`;
  err.azFix = f.fix;
  if (opts?.command) err.command = opts.command;
  return err;
}
