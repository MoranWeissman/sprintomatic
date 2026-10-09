/**
 * sprintomatic backend config.
 *
 * Each of the four values follows the one rule (./user-config): env var, then
 * stored setting. In CLI mode, a value set in neither place is asked of the
 * `az` CLI defaults, so the user doesn't have to maintain a separate config.
 * In API mode there's no `az` to ask, so a missing value is an error. Which
 * mode is active is decided in ./ado-client.
 */
import { execFile } from 'node:child_process';
import { azFailureError } from './az-error';
import { promisify } from 'node:util';
import { getAdoAccessMode } from './ado-client';
import { configValue } from './user-config';
import { SetupNeededError } from './setup-needed';

const exec = promisify(execFile);

export interface AdoConfig {
  organization: string;
  project: string;
  team: string;
  user: string;
}

let cached: AdoConfig | null = null;
/** Which mode the cached config was read for — the two sources differ. */
let cachedMode: 'cli' | 'api' | null = null;

export async function loadAdoConfig(): Promise<AdoConfig> {
  // Keyed on the mode for the same reason the client is (see ado-client.ts):
  // a long-running process must not keep serving config it read through the
  // door that has since been replaced.
  const mode = getAdoAccessMode();
  if (cached && cachedMode === mode) return cached;
  cached = mode === 'api' ? loadConfigFromStore() : await loadConfigFromCli();
  cachedMode = mode;
  return cached;
}

/** Forget the cached config so the next load re-reads it (e.g. after a mode switch). */
export function invalidateAdoConfig(): void {
  cached = null;
  cachedMode = null;
}

async function loadConfigFromCli(): Promise<AdoConfig> {
  const [organization, project] = await Promise.all([
    azDefault('organization', 'SPRINTOMATIC_ADO_ORG', 'ado_org'),
    azDefault('project', 'SPRINTOMATIC_ADO_PROJECT', 'ado_project'),
  ]);

  // Checked before asking for the team: on a fresh machine the team lookup
  // fails too, and its error would hide the real cause (nothing is set up).
  if (!organization) throw new SetupNeededError('No Azure DevOps organization is set. Fill it in under Settings, or run: az devops configure --defaults organization=https://dev.azure.com/<your-org>');
  if (!project) throw new SetupNeededError('No Azure DevOps project is set. Fill it in under Settings, or run: az devops configure --defaults project=<your-project>');

  const [team, user] = await Promise.all([resolveTeam(), resolveUser()]);
  if (!team) throw new Error('ADO team not resolvable. Set SPRINTOMATIC_ADO_TEAM env var or ensure exactly one team exists in the project.');
  if (!user) throw new Error('ADO user not resolvable. Ensure `az login` succeeded.');

  return { organization, project, team, user };
}

/** API mode: org/project/team/user come from env, then stored settings. */
function loadConfigFromStore(): AdoConfig {
  const organization = configValue('SPRINTOMATIC_ADO_ORG', 'ado_org');
  const project = configValue('SPRINTOMATIC_ADO_PROJECT', 'ado_project');
  const team = configValue('SPRINTOMATIC_ADO_TEAM', 'ado_team');
  const user = configValue('SPRINTOMATIC_ADO_USER', 'ado_user');

  // In token mode there is no az to ask, so every one of these must be filled in.
  if (!organization) throw new SetupNeededError('No Azure DevOps organization is set. Fill it in under Settings (e.g. https://dev.azure.com/<your-org>).');
  if (!project) throw new SetupNeededError('No Azure DevOps project is set. Fill it in under Settings.');
  if (!team) throw new SetupNeededError('No Azure DevOps team is set. Fill it in under Settings.');
  if (!user) throw new SetupNeededError('Your Azure DevOps identity is not set. Fill it in under Settings (the email new items get assigned to).');

  return { organization, project, team, user };
}

/**
 * Org or project in CLI mode: the environment variable, then the stored
 * setting, then whatever `az devops configure --defaults` has.
 *
 * The call site used to read `azDefault(key) ?? process.env.X`, which cannot
 * work: this function returns a promise, a promise is always truthy, so the
 * `??` never chose the environment variable — setting SPRINTOMATIC_ADO_ORG did nothing
 * for months. Each resolver now owns its own fallback, the way resolveTeam
 * always has, and the environment wins because that is what this file has
 * promised from the start.
 */
async function azDefault(
  key: 'organization' | 'project',
  envKey: 'SPRINTOMATIC_ADO_ORG' | 'SPRINTOMATIC_ADO_PROJECT',
  settingKey: 'ado_org' | 'ado_project',
): Promise<string | undefined> {
  const configured = configValue(envKey, settingKey);
  if (configured) return configured;
  try {
    const { stdout } = await exec('az', ['devops', 'configure', '--list']);
    const match = stdout.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
    return match?.[1].trim();
  } catch {
    return undefined;
  }
}

async function resolveTeam(): Promise<string | undefined> {
  const configured = configValue('SPRINTOMATIC_ADO_TEAM', 'ado_team');
  if (configured) return configured;
  let stdout: string;
  try {
    ({ stdout } = await exec('az', ['devops', 'team', 'list', '--query', '[].name', '-o', 'tsv']));
  } catch (err) {
    // The `az` call itself failed. This is almost never a team-setup problem —
    // it's a broken sign-in (expired or corrupted az token cache). Say so, so
    // it isn't misread as "you have the wrong number of teams". The read paths
    // can keep working long after this breaks (the token was still valid then),
    // which is exactly when this surfaces mid-session.
    const e = err as { stderr?: string; message?: string; code?: string };
    throw azFailureError((e.stderr || e.message || String(err)).trim(), e.code, {
      lead: "Couldn't read your team from Azure DevOps — nothing is wrong with your team setup, this is about reaching the board.",
    });
  }
  const teams = stdout.split('\n').map(s => s.trim()).filter(Boolean);
  if (teams.length === 1) return teams[0];
  if (teams.length === 0) {
    throw new SetupNeededError('No teams came back for this Azure DevOps project. Fill in the team under Settings.');
  }
  throw new SetupNeededError(
    `This Azure DevOps project has ${teams.length} teams (${teams.join(', ')}). Pick the one you plan with under Settings.`,
  );
}

async function resolveUser(): Promise<string | undefined> {
  // Same rule as API mode — otherwise the same variable works or doesn't
  // depending on a setting nobody connects to it.
  const configured = configValue('SPRINTOMATIC_ADO_USER', 'ado_user');
  if (configured) return configured;
  try {
    const { stdout } = await exec('az', ['account', 'show', '--query', 'user.name', '-o', 'tsv']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
