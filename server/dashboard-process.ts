/**
 * Keeping the dashboard alive without the user thinking about it.
 *
 * The dashboard (server/serve.ts: data API + built screens on one port)
 * would otherwise be started by hand. Every `orient` call asks "is the
 * dashboard answering?" and, when it isn't, starts it in the background —
 * so opening a chat IS turning the system on. The started process outlives
 * the chat on purpose; it dies at reboot or via `dashboard_stop`.
 *
 * Two chats can ask at the same time. That race is settled by the port, not
 * by us: the server can't bind a port that is taken, so the second starter
 * simply exits (see server/serve.ts).
 * Nothing here needs a lock.
 *
 * Everything talking to the outside world (HTTP ping, spawning, the pid
 * file, killing) is injected so tests never start real servers.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DASHBOARD_PORT = 7777;
const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`;

/** How long the health ping may take before we call the dashboard down.
 *  It's a localhost call — when it's up it answers in milliseconds. */
const PING_TIMEOUT_MS = 800;

export interface DashboardState {
  status: 'already-up' | 'started' | 'failed';
  /** Pre-formatted plain-English line for the model to echo (or stay silent on). */
  note: string | null;
}

export interface DashboardProcessDeps {
  ping: () => Promise<boolean>;
  /** Start `npm start` detached in the repo; returns the child pid or null. */
  spawnDashboard: (repoRoot: string) => number | null;
  readPid: () => number | null;
  writePid: (pid: number) => void;
  clearPid: () => void;
  /** Send a kill signal; false when the process wasn't there. */
  kill: (pid: number) => boolean;
}

function stateDir(): string {
  return join(homedir(), '.sprintomatic');
}

function pidFile(): string {
  return join(stateDir(), 'dashboard.pid');
}

async function realPing(): Promise<boolean> {
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/health`, {
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function realSpawn(repoRoot: string): number | null {
  const logDir = join(stateDir(), 'logs');
  mkdirSync(logDir, { recursive: true });
  // The dashboard's own output goes to a file, not to the MCP's stdio —
  // stdio here is the MCP protocol channel and must stay clean.
  const out = openSync(join(logDir, 'dashboard.log'), 'a');
  const child = spawn('npm', ['start'], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', out, out],
    // On Windows `npm` is a .cmd, which only a shell can start.
    shell: process.platform === 'win32',
  });
  // Let the MCP process exit without taking the dashboard with it.
  child.unref();
  return child.pid ?? null;
}

function realReadPid(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(pidFile(), 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function realWritePid(pid: number): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(pidFile(), `${pid}\n`);
}

function realClearPid(): void {
  rmSync(pidFile(), { force: true });
}

function realKill(pid: number): boolean {
  try {
    // Negative pid = the whole detached process group (npm + the server), so we
    // don't orphan the actual server by killing only npm. Windows has no
    // process groups; there the plain pid is the best available.
    process.kill(process.platform === 'win32' ? pid : -pid);
    return true;
  } catch {
    // The group may be gone while npm itself lingers, or vice versa — try
    // the plain pid before giving up.
    try {
      process.kill(pid);
      return true;
    } catch {
      return false;
    }
  }
}

const realDeps: DashboardProcessDeps = {
  ping: realPing,
  spawnDashboard: realSpawn,
  readPid: realReadPid,
  writePid: realWritePid,
  clearPid: realClearPid,
  kill: realKill,
};

/**
 * Make sure the dashboard is running; start it when it isn't. Never throws —
 * the greeting must not die because a helper process wouldn't start.
 */
export async function ensureDashboardRunning(
  repoRoot: string,
  deps: DashboardProcessDeps = realDeps,
): Promise<DashboardState> {
  try {
    if (await deps.ping()) {
      return { status: 'already-up', note: null };
    }
    const pid = deps.spawnDashboard(repoRoot);
    if (pid == null) {
      return {
        status: 'failed',
        note: `The dashboard isn't running and starting it didn't work. Start it by hand: npm start in the sprintomatic folder, then check ${DASHBOARD_URL}.`,
      };
    }
    deps.writePid(pid);
    return {
      status: 'started',
      note: `Started the dashboard in the background — ${DASHBOARD_URL} will answer in a few seconds.`,
    };
  } catch (err) {
    return {
      status: 'failed',
      note: `The dashboard isn't running and starting it didn't work (${err instanceof Error ? err.message : String(err)}). Start it by hand: npm start in the sprintomatic folder.`,
    };
  }
}

/**
 * Stop a dashboard we started. Says plainly when there is nothing to stop —
 * including a dashboard started by hand in a terminal, which we have no pid
 * for and must not guess at.
 */
export async function stopDashboard(
  deps: DashboardProcessDeps = realDeps,
): Promise<{ stopped: boolean; note: string }> {
  const pid = deps.readPid();
  if (pid == null) {
    const up = await deps.ping();
    return {
      stopped: false,
      note: up
        ? 'The dashboard is running, but not one this tool started — stop it in the terminal where it runs (Ctrl-C).'
        : 'The dashboard is not running; nothing to stop.',
    };
  }
  const killed = deps.kill(pid);
  deps.clearPid();
  return {
    stopped: killed,
    note: killed
      ? 'Dashboard stopped. Any chat can start it again just by greeting.'
      : 'The dashboard process was already gone; cleared the leftover record of it.',
  };
}
