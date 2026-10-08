/**
 * The dashboard's data API — every `/api/...` route the screens call.
 *
 * This used to live inside vite.config.ts as a dev-server plugin, which meant
 * the dashboard could only run in developer mode. It now stands alone so
 * server/serve.ts can run it as a normal program; in developer mode Vite
 * forwards `/api` to that program instead of running its own copy.
 *
 * Modules are imported inside each route on purpose: `/api/health` must answer
 * without opening the database, and nothing heavy loads until it's needed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isSetupNeeded } from './setup-needed';

type Next = (err?: unknown) => void;
type Route = (req: IncomingMessage, res: ServerResponse, next: Next) => unknown;
export type ApiHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * The few lines of routing the routes below were written against: a route
 * mounted at `/api/workitem` sees `/api/workitem/100001/edit` as
 * `/100001/edit`, and routes are tried in the order they were added. This is
 * the same rule Vite's own middleware used, so the routes moved over as-is.
 */
export function router() {
  const routes: { prefix: string; fn: Route }[] = [];
  return {
    use(prefix: string, fn: Route) {
      routes.push({ prefix: prefix.replace(/\/$/, ''), fn });
    },
    handle(req: IncomingMessage, res: ServerResponse) {
      const original = req.url ?? '/';
      const pathname = original.split('?')[0];
      const tryFrom = (i: number, err?: unknown): void => {
        req.url = original;
        if (err) return fail(res, err);
        for (let j = i; j < routes.length; j++) {
          const { prefix, fn } = routes[j];
          const after = pathname[prefix.length];
          if (!pathname.startsWith(prefix) || (after !== undefined && after !== '/' && after !== '.')) continue;
          const rest = original.slice(prefix.length);
          req.url = rest.startsWith('/') ? rest : `/${rest}`;
          try {
            void Promise.resolve(fn(req, res, (e) => tryFrom(j + 1, e))).catch((e) => fail(res, e));
          } catch (e) {
            fail(res, e);
          }
          return;
        }
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `No such route: ${pathname}` }));
      };
      tryFrom(0);
    },
  };
}

function fail(res: ServerResponse, err: unknown) {
  if (res.headersSent) return void res.end();
  res.statusCode = 500;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'unknown error' }));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/** Request methods that can change something (block a task, move a sprint, open Finder). */
const CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Refuse a request that changes something when it came from another web page.
 *
 * The API has no password and listens on localhost, so any site the user has
 * open in the same browser could post to it and block a task, move work into
 * another sprint, or pop open a Finder window. Browsers put a `Sec-Fetch-Site`
 * header on every request they send and page JavaScript cannot fake it, so it
 * tells us who is calling:
 *
 *   same-origin              the dashboard itself                  -> allow
 *   none                     the user typed the address / bookmark -> allow
 *   header not there at all  curl, node fetch, the MCP server      -> allow
 *   cross-site / same-site   some other web page                   -> refuse
 *
 * The missing case must stay allowed — callers outside a browser send no such
 * header, and a browser making a request from another site always sends one,
 * so nothing risky gets through.
 */
function refuseWritesFromOtherSites(
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) {
  if (!CHANGING_METHODS.has((req.method ?? 'GET').toUpperCase())) return next();
  const raw = req.headers['sec-fetch-site'];
  const site = Array.isArray(raw) ? raw[0] : raw;
  if (site === undefined || site === 'same-origin' || site === 'none') return next();
  res.statusCode = 403;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    error: 'This request came from another web page. Only the dashboard itself can change things here.',
  }));
}

/**
 * Builds the API. Call once per process: it also warms the dashboard cache in
 * the background and starts the auto-refresh timer.
 */
export function createApi(): ApiHandler {
  const api = router();
  const startedAt = new Date().toISOString();

  api.use('/api', refuseWritesFromOtherSites);

  // A plain "is the tool alive" check. Reads only — never opens the
  // database (that would trigger the WAL backup another part of this
  // project runs on open) and never writes or warms anything.
  api.use('/api/health', (_req, res) => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    const dbPath = join(homedir(), '.sprintomatic', 'data.db');
    let db: { exists: boolean; lastWritten: string | null } = { exists: false, lastWritten: null };
    try {
      // Recent writes sit in the -wal sidecar until a checkpoint folds them
      // back in, so the main file's own timestamp can be days old while the
      // tool is in active use. Report the newest of the two, or the health
      // check would claim the store is cold when it is not.
      const stamps = [dbPath, `${dbPath}-wal`].map(f => {
        try { return statSync(f).mtimeMs; } catch { return 0; }
      });
      statSync(dbPath);
      db = { exists: true, lastWritten: new Date(Math.max(...stamps)).toISOString() };
    } catch {
      // No database file yet — first run, or a fresh machine.
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({
      ok: true,
      version: pkg.version ?? null,
      startedAt,
      nodeVersion: process.version,
      db,
    }));
  });

  // Pre-warm at startup: transform the backend module graph + warm the ADO
  // iteration cache + az token + the dashboard cache in the background, so
  // the FIRST page load after `npm start` hits the fast (warm) path.
  // After the warm, kick off the auto-refresh timer so the Outlook-derived
  // 'available' tile catches meeting changes even when the dashboard is
  // idle in a browser tab.
  void (async () => {
    try {
      const { buildDashboardCached, startAutoRefresh } = await import('./dashboard-cache');
      await buildDashboardCached();
      startAutoRefresh();
    } catch {
      // Ignore — a real request will surface any error (e.g. az login needed).
    }
  })();

  api.use('/api/dashboard', async (req, res) => {
    try {
      const { buildDashboardCached } = await import('./dashboard-cache');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const sprintName = url.searchParams.get('sprint') ?? undefined;
      const result = await buildDashboardCached({ sprintName });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Cache', result.cache);
      res.setHeader('X-Cache-Age-Ms', String(result.cacheAgeMs));
      // Set only when refreshes keep failing, i.e. what we're serving is
      // frozen. Goes in the body, not just a header, so the page can say so
      // instead of quietly showing old numbers.
      res.end(JSON.stringify(
        result.refreshError ? { ...result.payload, refreshError: result.refreshError } : result.payload,
      ));
    } catch (err) {
      const e = err as Error & {
        command?: string;
        azHeadline?: string;
        azMessage?: string;
        azFix?: string | null;
      };
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: e?.azMessage ?? (err instanceof Error ? e.message : 'unknown error'),
          command: e?.command,
          // The headline and the one thing to do about it, when the failure
          // came from `az` — so the page names the real problem instead of
          // always blaming the network. See server/az-error.ts.
          headline: e?.azHeadline,
          fix: e?.azFix ?? undefined,
          // Something was never filled in — the page shows "not set up yet"
          // and a way into Settings instead of an error.
          setupNeeded: isSetupNeeded(err) || undefined,
        }),
      );
    }
  });

  api.use('/api/workitem/', async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const m = url.pathname.match(/^\/(\d+)(?:\/(edit|block|unblock))?/);
      if (!m) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Work item id must be a number' }));
        return;
      }
      const id = Number(m[1]);
      const action = m[2]; // 'edit' | 'block' | 'unblock' | undefined

      if (action === 'block' || action === 'unblock') {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'POST only' }));
          return;
        }
        // One-click block/unblock from the drawer. No reason captured (the
        // 'why' lives in the chat-driven workitem_block tool); this is the
        // lightweight twin. The Blocked tag is added/removed alongside the
        // state flip so a drawer-blocked item looks identical on the board.
        const { transitionToBlocked, transitionFromBlocked, updateTags } = await import('./writes');
        let state: string;
        if (action === 'block') {
          const change = await transitionToBlocked(id);
          await updateTags(id, { add: ['Blocked'] });
          state = change.toState;
        } else {
          const change = await transitionFromBlocked(id);
          await updateTags(id, { remove: ['Blocked'] });
          state = change.toState;
        }
        const { invalidateDashboardCache } = await import('./dashboard-cache');
        invalidateDashboardCache();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ state }));
        return;
      }

      if (action === 'edit') {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'POST only' }));
          return;
        }
        const body = (await readJsonBody(req)) as {
          state?: 'waiting' | 'going' | 'done';
          completedHours?: number;
          originalEstimate?: number;
          remainingWork?: number;
          iterationPath?: string;
        };
        // Original Estimate is set once at creation and never edited after
        // (same lock as the workitem_edit MCP tool). Refuse changing it here
        // too, so both doors keep one promise.
        if (body.originalEstimate != null) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Original Estimate is set once when a task is created and cannot be edited afterwards.' }));
          return;
        }
        const { setCompletedWork, setIterationPath, setRemaining, setStateBucket } = await import('./writes');
        const applied: Record<string, unknown> = {};
        if (body.state) {
          if (!['waiting', 'going', 'done'].includes(body.state)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'state must be waiting | going | done' }));
            return;
          }
          if (body.state === 'done') {
            // Closing must capture the real hours, exactly like
            // session_end({done:true, completedHoursAfter}). A bare "mark
            // done" with no hours is refused — the dashboard door keeping
            // the same lock as the AI door.
            const h = body.completedHours;
            if (h == null || !Number.isFinite(h) || h <= 0 || h > 999) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Closing a task needs completedHours — the hours it actually took — as a number greater than 0 (max 999).' }));
              return;
            }
            await setCompletedWork(id, h);
            await setRemaining(id, 0);
            applied.state = await setStateBucket(id, 'done');
            applied.completedHours = h;
            applied.remainingWork = 0;
          } else {
            applied.state = await setStateBucket(id, body.state);
          }
        }
        if (body.remainingWork != null && body.state !== 'done') {
          if (!Number.isFinite(body.remainingWork) || body.remainingWork < 0 || body.remainingWork > 999) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'remainingWork must be a finite number in [0, 999]' }));
            return;
          }
          await setRemaining(id, body.remainingWork);
          applied.remainingWork = body.remainingWork;
        }
        if (body.iterationPath != null) {
          if (typeof body.iterationPath !== 'string' || body.iterationPath.length === 0) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'iterationPath must be a non-empty string' }));
            return;
          }
          await setIterationPath(id, body.iterationPath);
          applied.iterationPath = body.iterationPath;
        }
        if (Object.keys(applied).length > 0) {
          const { invalidateDashboardCache } = await import('./dashboard-cache');
          invalidateDashboardCache();
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ applied }));
        return;
      }

      const { getWorkItem, getWorkItemComments } = await import('./ado');
      const [item, comments] = await Promise.all([getWorkItem(id), getWorkItemComments(id).catch(() => [])]);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ item, comments }));
    } catch (err) {
      const e = err as Error & {
        command?: string;
        azHeadline?: string;
        azMessage?: string;
        azFix?: string | null;
      };
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: e?.azMessage ?? (err instanceof Error ? e.message : 'unknown error'),
          command: e?.command,
          // The headline and the one thing to do about it, when the failure
          // came from `az` — so the page names the real problem instead of
          // always blaming the network. See server/az-error.ts.
          headline: e?.azHeadline,
          fix: e?.azFix ?? undefined,
        }),
      );
    }
  });

  // The settings screen. GET lists every setting with the value in use and
  // where it comes from; PUT saves a set of them (all or nothing). Two
  // actions: `check` tries the board and reads its state names, and
  // `move-token` moves a plain-text token into the Mac Keychain.
  api.use('/api/settings', async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };
    const registry = await import('./settings-registry');
    const { keychainAvailable } = await import('./secrets');
    const current = () => ({
      settings: registry.listSettings(),
      keychain: keychainAvailable(),
      tokenCanMoveToKeychain: registry.tokenCanMoveToKeychain(),
    });
    // A board setting changed: drop everything this process remembered about
    // the old board so the next read uses the new one.
    const forgetBoard = async () => {
      const { invalidateAdoConfig } = await import('./config');
      const { resetAdoClient } = await import('./ado-client');
      const { invalidateDashboardCache } = await import('./dashboard-cache');
      invalidateAdoConfig();
      resetAdoClient();
      invalidateDashboardCache();
    };
    const method = (req.method ?? 'GET').toUpperCase();
    const action = (req.url ?? '/').split('?')[0].replace(/^\/+|\/+$/g, '');
    try {
      if (action === '' && method === 'GET') return send(200, current());
      if (action === '' && method === 'PUT') {
        const body = (await readJsonBody(req)) as { values?: Record<string, string> };
        try {
          registry.saveSettings(body.values ?? {});
        } catch (err) {
          if (err instanceof registry.SettingError) return send(400, { error: err.message, key: err.key });
          throw err;
        }
        await forgetBoard();
        return send(200, current());
      }
      if (action === 'move-token' && method === 'POST') {
        const { moveTokenToKeychain } = await import('./secrets');
        const where = moveTokenToKeychain();
        await forgetBoard();
        return send(200, { ...current(), movedTo: where });
      }
      if (action === 'check' && method === 'POST') {
        const { probeBoardStates } = await import('./state-probe');
        const { isSetupNeeded } = await import('./setup-needed');
        try {
          const states = await probeBoardStates();
          return send(200, { ok: true, states });
        } catch (err) {
          const e = err as Error & { azMessage?: string; azFix?: string | null };
          return send(200, {
            ok: false,
            setupNeeded: isSetupNeeded(err),
            error: e?.azMessage ?? (err instanceof Error ? err.message : String(err)),
            fix: e?.azFix ?? undefined,
          });
        }
      }
      return send(405, { error: 'GET or PUT /api/settings, POST /api/settings/check or /api/settings/move-token' });
    } catch (err) {
      return send(500, { error: err instanceof Error ? err.message : 'unknown error' });
    }
  });

  api.use('/api/schedule', async (req, res) => {
    try {
      const { getCeremonySchedule, setCeremonySchedule } = await import('./ceremony');
      const method = req.method ?? 'GET';
      if (method === 'GET') {
        const schedule = getCeremonySchedule();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(schedule));
        return;
      }
      if (method === 'PUT' || method === 'POST') {
        const body = await readJsonBody(req);
        try {
          setCeremonySchedule(body as never);
        } catch (validationErr) {
          const msg = validationErr instanceof Error ? validationErr.message : 'invalid schedule';
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: msg }));
          return;
        }
        const saved = getCeremonySchedule();
        const { invalidateDashboardCache } = await import('./dashboard-cache');
        invalidateDashboardCache();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(saved));
        return;
      }
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'GET, PUT, or POST only' }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: message }));
    }
  });

  api.use('/api/helper-note/', async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const m = url.pathname.match(/^\/(\d+)\/(dismiss|pin|unpin)\/?$/);
      if (!m) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Expected /api/helper-note/<id>/(dismiss|pin|unpin)' }));
        return;
      }
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'POST only' }));
        return;
      }
      const id = Number(m[1]);
      const action = m[2];
      const { dismissNote, pinNote, unpinNote } = await import('./helper-notes');
      const changed =
        action === 'dismiss' ? dismissNote(id) : action === 'pin' ? pinNote(id) : unpinNote(id);
      if (changed) {
        const { invalidateDashboardCache } = await import('./dashboard-cache');
        invalidateDashboardCache();
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ ok: changed }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: message }));
    }
  });

  api.use('/api/carry-forward', async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'POST only' }));
        return;
      }
      const body = (await readJsonBody(req)) as { taskIds?: unknown };
      const taskIds = Array.isArray(body.taskIds)
        ? body.taskIds.map(Number).filter((n) => Number.isFinite(n))
        : [];

      // The client never sends a sprint path — the server resolves the
      // current sprint so a stale browser can't move tasks into the wrong
      // iteration.
      const { getCurrentIteration } = await import('./ado');
      const iteration = await getCurrentIteration();
      if (!iteration) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'No active sprint.' }));
        return;
      }
      const path = iteration.path;

      const { setIterationPath } = await import('./writes');
      let moved = 0;
      const failed: number[] = [];
      // Per-id failures never abort the batch — one bad id shouldn't strand
      // the rest.
      for (const id of taskIds) {
        try {
          await setIterationPath(id, path);
          moved++;
        } catch {
          failed.push(id);
        }
      }

      const { invalidateDashboardCache } = await import('./dashboard-cache');
      invalidateDashboardCache();

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ moved, failed }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: message }));
    }
  });

  api.use('/api/planning/gaps', async (req, res) => {
    try {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'GET only' }));
        return;
      }
      const { findGaps } = await import('./planning');
      const result = await findGaps();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: message }));
    }
  });

  api.use('/api/retro/save', async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'POST only' }));
        return;
      }
      const body = (await readJsonBody(req)) as {
        sprintName?: string;
        items?: { key: string; bucket: 'well' | 'way' | 'talk'; text: string; decision: 'keep' | 'drop' }[];
      };
      if (!body.sprintName || !Array.isArray(body.items)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'sprintName and items are required' }));
        return;
      }
      const { saveRetro } = await import('./retro');
      const saved = saveRetro(body.sprintName, body.items);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(saved));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: message }));
    }
  });

  api.use('/api/retro', async (req, res) => {
    try {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'GET only' }));
        return;
      }
      const { buildRetro } = await import('./retro');
      const result = await buildRetro();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: message }));
    }
  });

  api.use('/api/planning/cockpit', async (req, res) => {
    try {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'GET only' }));
        return;
      }
      const { buildCockpitPayload } = await import('./planning-cockpit');
      const result = await buildCockpitPayload();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: message }));
    }
  });

  api.use('/api/preplan', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const {
        buildPrePlanPayload,
        getPrePlanState,
        savePrePlanState,
      } = await import('./preplan');

      if (req.method === 'POST') {
        const body = (await readJsonBody(req)) as {
          story?: { id: string; call?: unknown; goalIndex?: number | null };
        };
        // Resolve the current sprint name server-side (don't trust the client).
        const current = await buildPrePlanPayload();
        const sprintName = current.sprintName;
        const state = getPrePlanState(sprintName);
        if (body.story && typeof body.story.id === 'string') {
          const prev = state.stories[body.story.id];
          state.stories[body.story.id] = {
            call: body.story.call !== undefined ? (body.story.call as never) : prev?.call,
            goalIndex:
              body.story.goalIndex !== undefined ? body.story.goalIndex : prev?.goalIndex,
          };
        }
        savePrePlanState(sprintName, state);
        res.end(JSON.stringify(await buildPrePlanPayload()));
        return;
      }

      res.end(JSON.stringify(await buildPrePlanPayload()));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      res.statusCode = 500;
      res.end(JSON.stringify({ error: message }));
    }
  });

  api.use('/api/discovery', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname; // '/' | '' for list, '/100901', '/100901/demo', '/100901/open-folder', '/100901/design', '/100901/diagram/<name>'
      const method = req.method ?? 'GET';

      const { getWorkspaces, getActiveFeature, getFeatureKind } = await import('./workspace');
      const { listTouchedFeatureFolders, deriveDndStatus, groupByDndStatus } = await import('./discovery-list');
      const { discoveryStatus, discoveryStartedAt, readDiscoveryDoc, writeDiscoveryDoc, hasHtmlArtifact, htmlArtifactPath, listMeetings } = await import('./discovery-store');
      const { getWorkItem } = await import('./ado');
      const { downloadAttachment } = await import('./ado-client');
      const { htmlToText } = await import('./html-preview');
      const { extractImages, rewriteImageUrls, imagesDir, isSafeImageName } = await import('./discovery-images');
      const { isDiscoveryStoryTitle, discoveryDayStage, discoveryDayLabel } = await import('./discovery');
      const { readdirSync } = await import('node:fs');
      const { readDesignDoc, listDesignMeetings, listDiagrams, diagramPath } = await import('./design-store');

      const touched = listTouchedFeatureFolders(
        getWorkspaces().paths,
        (dir) => readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name),
      );

      // ---- LIST ----
      if (path === '/' || path === '') {
        if (method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET only' })); return; }
        const active = getActiveFeature();
        const now = new Date();
        // A GROUPING feature (The user wrote the stories first and made the
        // feature to gather them) is board-only: no discovery, no design,
        // nothing to show here. New ones get no folder at all, but ones
        // created before that rule still have one on disk — so filter by
        // kind, not just by folder. An unknown kind stays on the page: we
        // never drop something because nobody has said what it is.
        const forDnd = touched.filter(f => getFeatureKind(f.id) !== 'grouping');
        const entries = await Promise.all(forDnd.map(async (f) => {
          const status = discoveryStatus(f.folderPath);
          let title: string | null = null;
          let boardState: string | null = null;
          let boardClosed = false;
          try {
            const wi = await getWorkItem(f.id);
            title = wi.title;
            const story = wi.children.find(c => c.type === 'User Story' && isDiscoveryStoryTitle(c.title));
            if (story) { boardState = story.state; boardClosed = story.state === 'Closed'; }
          } catch { /* ADO down — list from folder truth */ }
          const dndStatus = deriveDndStatus({ hasDiscovery: status.hasDiscovery, boardClosed });
          // The file being complete no longer flips the status — it's a hint
          // the row shows on an in-progress feature: "written, ready to close".
          const readyToClose = dndStatus === 'in-progress' && status.finished;
          let dayLabel: string | null = null;
          if (active && active.id === f.id && dndStatus === 'in-progress') {
            // Count from when discovery.json appeared, NOT from when the
            // feature folder was opened. This is the second home of the same
            // bug fixed in orient — active.setAt measured the wrong thing.
            const { workday, stage } = discoveryDayStage({
              firstSessionAt: discoveryStartedAt(f.folderPath) ?? active.setAt,
              now,
            });
            dayLabel = discoveryDayLabel(stage, workday);
          }
          return {
            id: f.id,
            displayName: title ? `**${title}** (#${f.id})` : `#${f.id}`,
            folderPath: f.folderPath,
            dndStatus, boardState, dayLabel, readyToClose,
          };
        }));
        res.end(JSON.stringify({ sections: groupByDndStatus(entries) }));
        return;
      }

      // ---- DETAIL / ACTIONS (/<id>[/board|/demo|/open-folder|/image/<name>|/design|/diagram/<name>]) ----
      const m = path.match(/^\/(\d+)(?:\/(board|demo|open-folder|image|html|design|diagram)(?:\/[^/]+)?)?\/?$/);
      if (!m) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Expected /api/discovery/<id>[/board|/demo|/open-folder|/image/<name>|/html/<kind>|/design|/diagram/<name>]' })); return; }
      const id = Number(m[1]);
      const action = m[2]; // 'board' | 'demo' | 'open-folder' | 'image' | 'html' | 'design' | 'diagram' | undefined
      const feature = touched.find(f => f.id === id);
      if (!feature) { res.statusCode = 404; res.end(JSON.stringify({ error: 'Not a touched feature' })); return; }
      const folderPath = feature.folderPath;

      // DOC — disk only. This must never wait on ADO: the discovery lives in
      // the workspace folder, so the Discovery/Demo tabs read instantly even
      // when the board is slow or unreachable.
      if (!action) {
        if (method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET only' })); return; }
        res.end(JSON.stringify({
          folderPath,
          doc: readDiscoveryDoc(folderPath),
          hasWalkthrough: hasHtmlArtifact(folderPath, 'walkthrough'),
          hasDemoHtml: hasHtmlArtifact(folderPath, 'demo'),
          meetings: listMeetings(folderPath),
        }));
        return;
      }

      // BOARD — ADO only, best-effort. Its own request so a slow board never
      // stalls the disk-backed doc. Degrades to empty if ADO is down.
      if (action === 'board') {
        if (method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET only' })); return; }
        let featureState: string | undefined;
        let featureDescription: string | undefined;
        let children: { id: number; title: string; type: string; state: string }[] = [];
        let reachable = true;
        try {
          const wi = await getWorkItem(id);
          featureState = wi.state;
          featureDescription = htmlToText(wi.description);
          children = wi.children.map(c => ({ id: c.id, title: c.title, type: c.type, state: c.state }));

          // Cache any embedded ADO images into the feature folder, then point
          // the description at the local serve route so the browser can show
          // them. Best-effort per image — a failed download keeps the caption.
          if (featureDescription) {
            const images = extractImages(featureDescription);
            if (images.length) {
              const { mkdir } = await import('node:fs/promises');
              const { existsSync } = await import('node:fs');
              const { join } = await import('node:path');
              const dir = imagesDir(folderPath);
              await mkdir(dir, { recursive: true });
              for (const img of images) {
                const dest = join(dir, img.localName);
                if (existsSync(dest)) continue; // already cached
                try { await downloadAttachment(img.url, dest); }
                catch { /* leave it — renderInline shows a caption for a missing local image */ }
              }
              featureDescription = rewriteImageUrls(featureDescription, id);
            }
          }
        } catch { reachable = false; }
        res.end(JSON.stringify({ reachable, featureState, featureDescription, children }));
        return;
      }

      // IMAGE — serve a cached attachment from the feature folder.
      const imgMatch = action === 'image' ? path.match(/\/image\/([^/]+)$/) : null;
      if (action === 'image') {
        if (method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET only' })); return; }
        const name = imgMatch ? decodeURIComponent(imgMatch[1]) : '';
        if (!isSafeImageName(name)) { res.statusCode = 400; res.end(JSON.stringify({ error: 'bad image name' })); return; }
        const { join } = await import('node:path');
        const { existsSync, readFileSync } = await import('node:fs');
        const file = join(imagesDir(folderPath), name);
        if (!existsSync(file)) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not cached' })); return; }
        const ext = (name.split('.').pop() || 'png').toLowerCase();
        const type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : 'image/png';
        res.setHeader('Content-Type', type);
        // These are cached attachments pulled from ADO, but the local copy can
        // still be re-downloaded/overwritten — a browser holding onto a stale
        // image for a day would show the wrong picture with no way to tell.
        res.setHeader('Cache-Control', 'no-store');
        res.end(readFileSync(file));
        return;
      }

      // HTML — serve a session-built artifact (walkthrough slideshow / concept
      // demo). Fixed filenames by kind; no free-form name → no path traversal.
      if (action === 'html') {
        if (method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET only' })); return; }
        const kindMatch = path.match(/\/html\/([^/]+)$/);
        const kind = kindMatch ? decodeURIComponent(kindMatch[1]) : '';
        if (kind !== 'walkthrough' && kind !== 'demo' && kind !== 'design-walkthrough') {
          res.statusCode = 400; res.end(JSON.stringify({ error: 'kind must be walkthrough | demo | design-walkthrough' })); return;
        }
        const { existsSync, readFileSync } = await import('node:fs');
        const file = htmlArtifactPath(folderPath, kind);
        if (!existsSync(file)) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not built' })); return; }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        // A rebuilt walkthrough/demo must show up the moment you reopen the
        // tab — never a cached copy from an earlier session.
        res.setHeader('Cache-Control', 'no-store');
        res.end(readFileSync(file));
        return;
      }

      // DESIGN — disk only, same discipline as the top-level discovery doc:
      // this must never wait on ADO. Reads the feature's `design/` subfolder
      // (design.json, meeting summaries, diagram names, whether the
      // walkthrough HTML was built) so the Design tab loads instantly.
      if (action === 'design') {
        if (method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET only' })); return; }
        res.end(JSON.stringify({
          folderPath,
          doc: readDesignDoc(folderPath),
          // The review opens with WHAT this is about — that text lives in
          // the discovery, so the design page borrows it (never rewrites it).
          problem: readDiscoveryDoc(folderPath)?.problem ?? '',
          meetings: listDesignMeetings(folderPath),
          diagrams: listDiagrams(folderPath),
          hasWalkthrough: hasHtmlArtifact(folderPath, 'design-walkthrough'),
        }));
        return;
      }

      // DIAGRAM — serve an SVG built during the design phase, from
      // `design/diagrams/`. Same shape as IMAGE above: a bad/unsafe name
      // (path traversal) or a missing file both come back as a 404.
      const diagramMatch = action === 'diagram' ? path.match(/\/diagram\/([^/]+)$/) : null;
      if (action === 'diagram') {
        if (method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET only' })); return; }
        const name = diagramMatch ? decodeURIComponent(diagramMatch[1]) : '';
        const file = diagramPath(folderPath, name);
        const { existsSync, readFileSync } = await import('node:fs');
        if (!file || !existsSync(file)) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' })); return; }
        res.setHeader('Content-Type', 'image/svg+xml');
        // Diagrams get redrawn during a design session — the browser must
        // fetch the new SVG every time, not hold on to yesterday's version.
        res.setHeader('Cache-Control', 'no-store');
        res.end(readFileSync(file));
        return;
      }

      if (action === 'demo') {
        if (method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST only' })); return; }
        const body = (await readJsonBody(req)) as { status?: unknown; date?: unknown };
        const status = body.status;
        if (status !== 'none' && status !== 'scheduled' && status !== 'built') {
          res.statusCode = 400; res.end(JSON.stringify({ error: 'status must be none | scheduled | built' })); return;
        }
        const date = typeof body.date === 'string' ? body.date : '';
        const doc = readDiscoveryDoc(folderPath);
        if (!doc) { res.statusCode = 409; res.end(JSON.stringify({ error: 'no discovery to mark' })); return; }
        doc.demo = { status, shape: doc.demo.shape, date, notes: doc.demo.notes };
        // The title only decorates the regenerated markdown header. Resolve it
        // best-effort; a slow/down board must not block the save.
        let displayName = `#${id}`;
        try { const wi = await getWorkItem(id); displayName = `**${wi.title}** (#${id})`; } catch { /* keep #id */ }
        writeDiscoveryDoc(folderPath, doc, displayName);
        res.end(JSON.stringify({ demo: doc.demo }));
        return;
      }

      // action === 'open-folder'
      if (method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST only' })); return; }
      const { spawn } = await import('node:child_process');
      const { join } = await import('node:path');
      let ok = true;
      try { spawn('open', [join(folderPath, 'discovery')], { detached: true, stdio: 'ignore' }).unref(); }
      catch { ok = false; }
      res.end(JSON.stringify({ ok }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      res.statusCode = 500;
      res.end(JSON.stringify({ error: message }));
    }
  });
  return (req, res) => api.handle(req, res);
}
