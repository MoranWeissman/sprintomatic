import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ado-client reads the access mode + token via getSetting. Back it with an
// in-memory map so mode selection can be driven without the real DB.
const h = vi.hoisted(() => ({ settings: new Map<string, string>() }));
vi.mock('./timers', () => ({
  getSetting: (k: string) => h.settings.get(k),
  setSetting: (k: string, v: string) => {
    h.settings.set(k, v);
  },
}));

import {
  CliAdoClient,
  RestAdoClient,
  getAdoClient,
  getAdoAccessMode,
  resetAdoClient,
} from './ado-client';

type FakeRes = {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
};
const res = (ok: boolean, status: number, statusText: string, body: string): FakeRes => ({
  ok,
  status,
  statusText,
  text: async () => body,
});
const okJson = (obj: unknown) => res(true, 200, 'OK', JSON.stringify(obj));

beforeEach(() => {
  h.settings.clear();
  delete process.env.SPRINTOMATIC_ADO_ACCESS_MODE;
  delete process.env.SPRINTOMATIC_ADO_PAT;
  resetAdoClient();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAdoClient();
});

describe('RestAdoClient.rest', () => {
  it('sends Basic auth and returns parsed JSON on success', async () => {
    const fetchMock = vi.fn(async () => okJson({ id: 5 }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await new RestAdoClient('tok').rest({
      method: 'GET',
      uri: 'https://dev.azure.com/org/_apis/wit/workitems/5',
    });

    expect(out).toEqual({ id: 5 });
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>).Authorization).toBe(
      'Basic ' + Buffer.from(':tok').toString('base64'),
    );
    expect(opts.method).toBe('GET');
    expect(opts.body).toBeUndefined();
  });

  it('uses json-patch content type and serializes the body for PATCH', async () => {
    const fetchMock = vi.fn(async () => okJson({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await new RestAdoClient('tok').rest({
      method: 'PATCH',
      uri: 'https://dev.azure.com/org/_apis/wit/workitems/5',
      body: [{ op: 'add', path: '/fields/System.State', value: 'Done' }],
      contentKind: 'json-patch',
    });

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('PATCH');
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json-patch+json',
    );
    expect(opts.body).toBe(JSON.stringify([{ op: 'add', path: '/fields/System.State', value: 'Done' }]));
  });

  it('throws a helpful error on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(false, 404, 'Not Found', 'no such item')));
    await expect(
      new RestAdoClient('tok').rest({ method: 'GET', uri: 'https://dev.azure.com/org/_apis/wit/workitems/9' }),
    ).rejects.toThrow(/404/);
  });

  it('detects the sign-in HTML page returned for an invalid token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(true, 200, 'OK', '<!DOCTYPE html><html>sign in</html>')));
    await expect(
      new RestAdoClient('bad').rest({ method: 'GET', uri: 'https://dev.azure.com/org/_apis/x' }),
    ).rejects.toThrow(/rejected the stored token/i);
  });

  it('returns undefined for an empty body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(true, 200, 'OK', '')));
    const out = await new RestAdoClient('tok').rest({ method: 'GET', uri: 'https://dev.azure.com/org/_apis/x' });
    expect(out).toBeUndefined();
  });
});

describe('RestAdoClient.queryWorkItems', () => {
  it('runs WIQL then hydrates via workitemsbatch, preserving WIQL order', async () => {
    const fetchMock = vi.fn(async (uri: string) => {
      if (uri.includes('/wiql')) return okJson({ workItems: [{ id: 3 }, { id: 1 }, { id: 2 }] });
      if (uri.includes('/workitemsbatch')) {
        // Deliberately out of order — the client must restore WIQL order.
        return okJson({
          value: [
            { id: 1, rev: 1, url: 'u1', fields: {} },
            { id: 2, rev: 1, url: 'u2', fields: {} },
            { id: 3, rev: 1, url: 'u3', fields: {} },
          ],
        });
      }
      throw new Error('unexpected uri ' + uri);
    });
    vi.stubGlobal('fetch', fetchMock);

    const items = await new RestAdoClient('tok').queryWorkItems({
      wiql: 'SELECT [System.Id] FROM WorkItems',
      fields: ['System.Id', 'System.Title'],
      organization: 'https://dev.azure.com/org',
      project: 'My Proj',
    });

    expect(items.map(i => i.id)).toEqual([3, 1, 2]);

    const batchCall = fetchMock.mock.calls.find(c => (c[0] as string).includes('workitemsbatch'))!;
    expect(JSON.parse((batchCall[1] as RequestInit).body as string)).toEqual({
      ids: [3, 1, 2],
      fields: ['System.Id', 'System.Title'],
    });
    // Project name is URL-encoded into the endpoint.
    expect(batchCall[0] as string).toContain('https://dev.azure.com/org/My%20Proj/_apis/wit/workitemsbatch');
  });

  it('skips the batch call entirely when WIQL matches nothing', async () => {
    const fetchMock = vi.fn(async () => okJson({ workItems: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const items = await new RestAdoClient('tok').queryWorkItems({
      wiql: 'SELECT [System.Id] FROM WorkItems',
      fields: ['System.Id'],
      organization: 'https://dev.azure.com/org',
      project: 'P',
    });

    expect(items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // wiql only, no hydrate
  });
});

describe('access mode selection', () => {
  it('defaults to cli, reads "api" from settings, and is case-insensitive', () => {
    expect(getAdoAccessMode()).toBe('cli');
    h.settings.set('ado_access_mode', 'api');
    expect(getAdoAccessMode()).toBe('api');
    h.settings.set('ado_access_mode', 'API');
    expect(getAdoAccessMode()).toBe('api');
    h.settings.set('ado_access_mode', 'nonsense');
    expect(getAdoAccessMode()).toBe('cli'); // anything but 'api' is cli
  });

  it('falls back to the env var when no setting is stored', () => {
    process.env.SPRINTOMATIC_ADO_ACCESS_MODE = 'api';
    expect(getAdoAccessMode()).toBe('api');
  });

  it('getAdoClient returns the CLI doorway by default', () => {
    expect(getAdoClient()).toBeInstanceOf(CliAdoClient);
  });

  it('getAdoClient returns the API doorway when api mode + token are set', () => {
    h.settings.set('ado_access_mode', 'api');
    h.settings.set('ado_pat', 'tok');
    expect(getAdoClient()).toBeInstanceOf(RestAdoClient);
  });

  it('getAdoClient refuses api mode with no token', () => {
    h.settings.set('ado_access_mode', 'api');
    expect(() => getAdoClient()).toThrow(/no token/i);
  });

  it('caches the client until reset', () => {
    const first = getAdoClient();
    expect(getAdoClient()).toBe(first); // same instance
    resetAdoClient();
    h.settings.set('ado_access_mode', 'api');
    h.settings.set('ado_pat', 'tok');
    expect(getAdoClient()).not.toBe(first); // rebuilt after reset + mode change
  });
});

/**
 * The bug these cover: the client was built once per process and only rebuilt
 * if someone remembered to call resetAdoClient(). Nothing in the running code
 * ever did, so a dashboard left running for weeks kept using the CLI long
 * after a token had been stored — every refresh failed, and restarting was the
 * only cure.
 */
describe('getAdoClient — follows the settings without being told', () => {
  it('switches door when the access mode changes, with no reset call', () => {
    h.settings.set('ado_access_mode', 'cli');
    expect(getAdoClient()).toBeInstanceOf(CliAdoClient);

    h.settings.set('ado_access_mode', 'api');
    h.settings.set('ado_pat', 'token-one');
    expect(getAdoClient()).toBeInstanceOf(RestAdoClient);

    h.settings.set('ado_access_mode', 'cli');
    expect(getAdoClient()).toBeInstanceOf(CliAdoClient);
  });

  it('rebuilds when the token changes, so a replaced PAT takes effect', () => {
    h.settings.set('ado_access_mode', 'api');
    h.settings.set('ado_pat', 'token-one');
    const first = getAdoClient();

    h.settings.set('ado_pat', 'token-two');
    const second = getAdoClient();
    expect(second).not.toBe(first);
    expect(second).toBeInstanceOf(RestAdoClient);
  });

  it('still hands back the same instance while nothing has changed', () => {
    h.settings.set('ado_access_mode', 'api');
    h.settings.set('ado_pat', 'token-one');
    expect(getAdoClient()).toBe(getAdoClient());
  });

  it('api mode with the token removed refuses instead of serving the old client', () => {
    h.settings.set('ado_access_mode', 'api');
    h.settings.set('ado_pat', 'token-one');
    getAdoClient();

    h.settings.delete('ado_pat');
    expect(() => getAdoClient()).toThrow(/no token is saved/i);
  });
});
