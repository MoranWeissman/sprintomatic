import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * These exist because of a bug that lived for months: the call site read
 * `azDefault(key) ?? process.env.SH_ADO_ORG`, and since a promise is always
 * truthy the environment variable was never reached. Nothing failed loudly —
 * setting SH_ADO_ORG just quietly did nothing.
 */

// Every `az` call in this module goes through execFile. Hand back whatever the
// test asked for, and record what was asked.
const h = vi.hoisted(() => ({
  mode: 'cli' as 'cli' | 'api',
  settings: new Map<string, string>(),
  calls: [] as string[][],
  out: new Map<string, string>(),
  fail: new Set<string>(),
}));

vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    args: string[],
    cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
  ) => {
    h.calls.push(args);
    const key = args.join(' ');
    if (h.fail.has(key)) {
      cb(Object.assign(new Error('az said no'), { stderr: 'ERROR: Run `az login`.' }));
      return;
    }
    cb(null, { stdout: h.out.get(key) ?? '', stderr: '' });
  },
}));

vi.mock('./ado-client', () => ({ getAdoAccessMode: () => h.mode }));
vi.mock('./timers', () => ({ getSetting: (k: string) => h.settings.get(k) }));

import { invalidateAdoConfig, loadAdoConfig } from './config';

const LIST = 'devops configure --list';
const TEAMS = 'devops team list --query [].name -o tsv';
const WHOAMI = 'account show --query user.name -o tsv';

const ENV_KEYS = ['SH_ADO_ORG', 'SH_ADO_PROJECT', 'SH_ADO_TEAM', 'SH_ADO_USER'] as const;

beforeEach(() => {
  h.mode = 'cli';
  h.settings.clear();
  h.calls = [];
  h.out.clear();
  h.fail.clear();
  for (const k of ENV_KEYS) delete process.env[k];
  invalidateAdoConfig();
});

/** The happy CLI setup: az knows everything. */
function azKnowsEverything() {
  h.out.set(LIST, 'organization = https://dev.azure.com/from-az\nproject = Project From Az\n');
  h.out.set(TEAMS, 'The Only Team\n');
  h.out.set(WHOAMI, 'someone@example.com\n');
}

describe('CLI mode — the environment wins', () => {
  it('uses the environment variables even when az has its own defaults', async () => {
    azKnowsEverything();
    process.env.SH_ADO_ORG = 'https://dev.azure.com/from-env';
    process.env.SH_ADO_PROJECT = 'Project From Env';

    const cfg = await loadAdoConfig();
    expect(cfg.organization).toBe('https://dev.azure.com/from-env');
    expect(cfg.project).toBe('Project From Env');
  });

  it('works with ONLY the environment set — az can be missing entirely', async () => {
    h.fail.add(LIST); // no az defaults at all
    process.env.SH_ADO_ORG = 'https://dev.azure.com/from-env';
    process.env.SH_ADO_PROJECT = 'Project From Env';
    process.env.SH_ADO_TEAM = 'Team From Env';
    process.env.SH_ADO_USER = 'someone@example.com';

    const cfg = await loadAdoConfig();
    expect(cfg).toEqual({
      organization: 'https://dev.azure.com/from-env',
      project: 'Project From Env',
      team: 'Team From Env',
      user: 'someone@example.com',
    });
  });

  it('never asks az anything when the environment already answers', async () => {
    for (const k of ENV_KEYS) process.env[k] = k === 'SH_ADO_ORG' ? 'https://dev.azure.com/o' : 'v';
    process.env.SH_ADO_USER = 'someone@example.com';

    await loadAdoConfig();
    expect(h.calls).toHaveLength(0);
  });

  it('falls back to az defaults when the environment is empty', async () => {
    azKnowsEverything();
    const cfg = await loadAdoConfig();
    expect(cfg.organization).toBe('https://dev.azure.com/from-az');
    expect(cfg.project).toBe('Project From Az');
    expect(cfg.team).toBe('The Only Team');
    expect(cfg.user).toBe('someone@example.com');
  });

  it('ignores an environment variable that is only spaces', async () => {
    azKnowsEverything();
    process.env.SH_ADO_ORG = '   ';
    const cfg = await loadAdoConfig();
    expect(cfg.organization).toBe('https://dev.azure.com/from-az');
  });

  it('says which piece is missing when neither side has it', async () => {
    h.fail.add(LIST);
    h.out.set(TEAMS, 'The Only Team\n');
    h.out.set(WHOAMI, 'someone@example.com\n');
    await expect(loadAdoConfig()).rejects.toThrow(/no azure devops organization/i);
  });
});

describe('API mode — stored settings, no az', () => {
  it('reads all four from the settings and never shells out', async () => {
    h.mode = 'api';
    h.settings.set('ado_org', 'https://dev.azure.com/stored');
    h.settings.set('ado_project', 'Stored Project');
    h.settings.set('ado_team', 'Stored Team');
    h.settings.set('ado_user', 'someone@example.com');

    const cfg = await loadAdoConfig();
    expect(cfg.organization).toBe('https://dev.azure.com/stored');
    expect(h.calls).toHaveLength(0);
  });
});

describe('one rule in both modes — env, then stored setting', () => {
  it('API mode: the environment beats the stored setting', async () => {
    h.mode = 'api';
    h.settings.set('ado_org', 'https://dev.azure.com/stored');
    h.settings.set('ado_project', 'Stored Project');
    h.settings.set('ado_team', 'Stored Team');
    h.settings.set('ado_user', 'someone@example.com');
    process.env.SH_ADO_TEAM = 'Team From Env';

    expect((await loadAdoConfig()).team).toBe('Team From Env');
  });

  it('CLI mode: a stored setting is used before asking az', async () => {
    azKnowsEverything();
    h.out.set(TEAMS, 'Team One\nTeam Two\n');
    h.settings.set('ado_team', 'Team Two');

    const cfg = await loadAdoConfig();
    expect(cfg.team).toBe('Team Two');
    expect(cfg.organization).toBe('https://dev.azure.com/from-az');
    expect(h.calls.map(c => c.join(' '))).not.toContain(TEAMS);
  });
});

describe('the config cache follows the mode', () => {
  it('re-reads after the mode changes instead of serving the other door values', async () => {
    azKnowsEverything();
    expect((await loadAdoConfig()).organization).toBe('https://dev.azure.com/from-az');

    h.mode = 'api';
    h.settings.set('ado_org', 'https://dev.azure.com/stored');
    h.settings.set('ado_project', 'Stored Project');
    h.settings.set('ado_team', 'Stored Team');
    h.settings.set('ado_user', 'someone@example.com');

    expect((await loadAdoConfig()).organization).toBe('https://dev.azure.com/stored');
  });
});
