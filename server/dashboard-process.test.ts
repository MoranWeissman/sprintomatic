import { describe, it, expect } from 'vitest';
import {
  ensureDashboardRunning,
  stopDashboard,
  type DashboardProcessDeps,
} from './dashboard-process';

function makeDeps(overrides: Partial<DashboardProcessDeps> = {}) {
  const calls = {
    spawned: [] as string[],
    wrotePid: [] as number[],
    clearedPid: 0,
    killed: [] as number[],
  };
  const deps: DashboardProcessDeps = {
    ping: async () => false,
    spawnDashboard: (repoRoot) => {
      calls.spawned.push(repoRoot);
      return 4242;
    },
    readPid: () => null,
    writePid: (pid) => {
      calls.wrotePid.push(pid);
    },
    clearPid: () => {
      calls.clearedPid++;
    },
    kill: (pid) => {
      calls.killed.push(pid);
      return true;
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('ensureDashboardRunning', () => {
  it('does nothing when the dashboard already answers', async () => {
    const { deps, calls } = makeDeps({ ping: async () => true });
    const state = await ensureDashboardRunning('/repo', deps);
    expect(state.status).toBe('already-up');
    expect(state.note).toBeNull();
    expect(calls.spawned).toHaveLength(0);
  });

  it('starts it in the repo folder and records the pid when it is down', async () => {
    const { deps, calls } = makeDeps();
    const state = await ensureDashboardRunning('/repo', deps);
    expect(state.status).toBe('started');
    expect(state.note).toMatch(/few seconds/);
    expect(calls.spawned).toEqual(['/repo']);
    expect(calls.wrotePid).toEqual([4242]);
  });

  it('reports failure with the manual fallback when spawning yields no pid', async () => {
    const { deps } = makeDeps({ spawnDashboard: () => null });
    const state = await ensureDashboardRunning('/repo', deps);
    expect(state.status).toBe('failed');
    expect(state.note).toMatch(/npm start/);
  });

  it('never throws — a broken ping becomes a failed status', async () => {
    const { deps } = makeDeps({
      ping: async () => {
        throw new Error('DNS exploded');
      },
    });
    const state = await ensureDashboardRunning('/repo', deps);
    expect(state.status).toBe('failed');
    expect(state.note).toMatch(/DNS exploded/);
  });
});

describe('stopDashboard', () => {
  it('kills the recorded pid and clears the record', async () => {
    const { deps, calls } = makeDeps({ readPid: () => 4242 });
    const result = await stopDashboard(deps);
    expect(result.stopped).toBe(true);
    expect(calls.killed).toEqual([4242]);
    expect(calls.clearedPid).toBe(1);
  });

  it('refuses to guess at a dashboard it did not start', async () => {
    const { deps, calls } = makeDeps({ readPid: () => null, ping: async () => true });
    const result = await stopDashboard(deps);
    expect(result.stopped).toBe(false);
    expect(result.note).toMatch(/not one this tool started/);
    expect(calls.killed).toHaveLength(0);
  });

  it('says plainly when nothing is running at all', async () => {
    const { deps } = makeDeps({ readPid: () => null, ping: async () => false });
    const result = await stopDashboard(deps);
    expect(result.stopped).toBe(false);
    expect(result.note).toMatch(/nothing to stop/);
  });

  it('clears a leftover record when the process was already gone', async () => {
    const { deps, calls } = makeDeps({ readPid: () => 4242, kill: () => false });
    const result = await stopDashboard(deps);
    expect(result.stopped).toBe(false);
    expect(result.note).toMatch(/already gone/);
    expect(calls.clearedPid).toBe(1);
  });
});
