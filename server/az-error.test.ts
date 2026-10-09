import { describe, it, expect } from 'vitest';
import { azFailureError, describeAzFailure, describeHttpFailure, httpFailureError } from './az-error';

/**
 * Every `raw` string below is a real failure text taken from the error log,
 * trimmed. The tracebacks are the reason this module exists: what the user
 * used to read was hundreds of lines of Python file paths.
 */

const SIGNED_OUT =
  'ERROR: Before you can run Azure DevOps commands, you need to run the login command(az login if using AAD/MSA identity else az devops login if using PAT token) to setup credentials.  Please see https://aka.ms/azure-devops-cli-auth for more information.';

const NO_ACCOUNT = "ERROR: User 'someone@example.com' does not exist in MSAL token cache. Run `az login`.";

const CACHE_BROKEN = `ERROR: The command failed with an unexpected error. Here is the traceback:
ERROR: Extra data: line 3 column 8 (char 31)
Traceback (most recent call last):
  File "/opt/homebrew/Cellar/azure-cli/2.75.0/libexec/lib/python3.12/site-packages/msal/application.py", line 1235, in get_accounts
    accounts = self._msal_app.get_accounts(username)`;

const OFFLINE = `ERROR: The command failed with an unexpected error. Here is the traceback:
ERROR: HTTPSConnectionPool(host='dev.azure.com', port=443): Max retries exceeded with url: /org/project/_apis/work/teamsettings/iterations?api-version=7.1 (Caused by NameResolutionError("<urllib3.connection.HTTPSConnection object at 0x106a484d0>: Failed to resolve 'dev.azure.com' ([Errno 8] nodename nor servname provided, or not known)"))
Traceback (most recent call last):
  File "/opt/homebrew/Cellar/azure-cli/2.75.0/libexec/lib/python3.12/site-packages/urllib3/connection.py", line 198, in _new_conn`;

describe('describeAzFailure — the four real failures', () => {
  it('signed out: names the sign-in, not the network', () => {
    const f = describeAzFailure(SIGNED_OUT);
    expect(f.kind).toBe('signed-out');
    expect(f.headline).toBe("You're signed out of Azure");
    expect(f.fix).toContain('az login');
  });

  it('missing account in the token cache is the same signed-out case', () => {
    expect(describeAzFailure(NO_ACCOUNT).kind).toBe('signed-out');
  });

  it('a damaged sign-in cache says so, and offers the file to delete', () => {
    const f = describeAzFailure(CACHE_BROKEN);
    expect(f.kind).toBe('cache-broken');
    expect(f.fix).toContain('msal_token_cache.json');
  });

  it('offline never tells the user to sign in again', () => {
    const f = describeAzFailure(OFFLINE);
    expect(f.kind).toBe('offline');
    expect(f.headline).toBe("Can't reach Azure DevOps");
    expect(f.text).not.toContain('az login');
    expect(f.fix).toContain('VPN');
  });

  it('no az on the machine is told apart by the process code alone', () => {
    const f = describeAzFailure('', 'ENOENT');
    expect(f.kind).toBe('az-missing');
    expect(f.message).toContain('`az`');
  });
});

describe('describeAzFailure — what the user never sees', () => {
  it('drops the Python traceback from every message', () => {
    for (const raw of [CACHE_BROKEN, OFFLINE]) {
      const f = describeAzFailure(raw);
      expect(f.text).not.toContain('Traceback');
      expect(f.text).not.toContain('site-packages');
      expect(f.text).not.toContain('.py');
    }
  });

  it('an unknown failure quotes one short line, never a wall of text', () => {
    const long = `ERROR: ${'x'.repeat(400)}\nTraceback (most recent call last):\n  File "a.py"`;
    const f = describeAzFailure(long);
    expect(f.kind).toBe('other');
    expect(f.message.length).toBeLessThan(230);
    expect(f.message).toContain('…');
    expect(f.fix).toBeNull();
  });

  it('a silent failure says it was silent instead of "unknown error"', () => {
    const f = describeAzFailure('');
    expect(f.kind).toBe('other');
    expect(f.message).toBe('The Azure CLI failed without saying why.');
  });
});

describe('describeAzFailure — no project configured', () => {
  it('a missing organization default is its own failure, not a sign-in one', () => {
    const f = describeAzFailure(
      'ERROR: --organization must be specified. The value should be the URI of your Azure DevOps organization, for example: https://dev.azure.com/MyOrganization/.',
    );
    expect(f.kind).toBe('not-configured');
    expect(f.fix).toContain('az devops configure');
    expect(f.text).not.toContain('az login');
  });
});

describe('azFailureError', () => {
  it('carries the headline, the short message and the fix on the Error', () => {
    const err = azFailureError('ERROR: Run `az login`.', undefined, { command: 'az boards query' });
    expect(err.azKind).toBe('signed-out');
    expect(err.azHeadline).toBe("You're signed out of Azure");
    expect(err.command).toBe('az boards query');
    expect(err.message).toContain(err.azFix as string);
    expect(err.azMessage).not.toContain(err.azFix as string);
  });

  it("a lead says what we were doing, in front of both the message and the text", () => {
    const err = azFailureError('ERROR: Run `az login`.', undefined, { lead: 'Reading your team failed.' });
    expect(err.azMessage.startsWith('Reading your team failed. ')).toBe(true);
    expect(err.message.startsWith('Reading your team failed. ')).toBe(true);
  });
});

describe('describeAzFailure — timed out', () => {
  it('a killed call says it took too long, even with no stderr to read', () => {
    const f = describeAzFailure('', 'ETIMEDOUT');
    expect(f.kind).toBe('timeout');
    expect(f.headline).toBe('The board took too long to answer');
    expect(f.text).not.toContain('az login');
  });
});

describe('describeAzFailure — a name that does not match the board', () => {
  it('reads a 404 from az as a wrong name, with setup as the fix', () => {
    const f = describeAzFailure('ERROR: The resource cannot be found.');
    expect(f.kind).toBe('not-found');
    expect(f.message).toContain('organization, project or team');
    expect(f.fix).toContain('npm run setup');
  });
});

describe('describeHttpFailure', () => {
  it('turns a 404 into plain words, never the address', () => {
    const f = describeHttpFailure(404, '{"message":"The resource cannot be found."}');
    expect(f.kind).toBe('not-found');
    expect(f.text).not.toMatch(/404|_apis/);
  });

  it('names the missing item when Azure DevOps says which one', () => {
    const f = describeHttpFailure(
      404,
      '{"message":"TF401232: Work item 100001 does not exist, or you do not have permissions to read it."}',
    );
    expect(f.message).toBe("Couldn't find #100001 on the board. It may have been deleted, or you can't see it.");
  });

  it('reads 401 and 403 as a token problem', () => {
    expect(describeHttpFailure(401, '').kind).toBe('signed-out');
    expect(describeHttpFailure(403, '').fix).toContain('npm run setup');
  });

  it('keeps the board message for anything else', () => {
    const f = describeHttpFailure(400, '{"message":"VS402337: The field is not valid."}');
    expect(f.message).toBe('Azure DevOps said (400): VS402337: The field is not valid.');
  });
});

describe('httpFailureError', () => {
  it('carries the headline and the fix, so the dashboard can show them', () => {
    const e = httpFailureError(404, '');
    expect(e.azHeadline).toBe("Couldn't find your board");
    expect(e.azFix).toContain('npm run setup');
  });
});
