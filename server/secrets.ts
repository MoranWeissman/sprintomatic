/**
 * Where the Azure DevOps token lives.
 *
 * On a Mac it goes in the Keychain, so it is not sitting in plain text in the
 * settings file. Everywhere else (or when the Keychain can't be reached) it
 * falls back to the `ado_pat` setting, and the settings screen says so.
 *
 * Lookup order, same as every other knob: SPRINTOMATIC_ADO_PAT, then the Keychain, then
 * the `ado_pat` setting.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { getSetting, setSetting } from './timers';

const SERVICE = 'sprintomatic';
const ACCOUNT = 'ado_pat';

/** Keychain reads cost a process start. The token is read on every board call. */
const CACHE_MS = 60_000;
let cache: { value: string | undefined; at: number } | null = null;

export type TokenSource = 'env' | 'keychain' | 'setting' | 'none';

/** SPRINTOMATIC_KEYCHAIN=off turns the Keychain off (tests set it so they never touch the real one). */
export function keychainAvailable(): boolean {
  return process.platform === 'darwin' && process.env.SPRINTOMATIC_KEYCHAIN !== 'off';
}

function readKeychain(): string | undefined {
  if (!keychainAvailable()) return undefined;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value: string | undefined;
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    value = out.trim() || undefined;
  } catch {
    value = undefined; // not stored there
  }
  cache = { value, at: Date.now() };
  return value;
}

/** The token and where it came from. Never log the value. */
export function readToken(): { value: string | undefined; source: TokenSource } {
  const env = process.env.SPRINTOMATIC_ADO_PAT?.trim();
  if (env) return { value: env, source: 'env' };
  const fromKeychain = readKeychain();
  if (fromKeychain) return { value: fromKeychain, source: 'keychain' };
  const fromSetting = getSetting('ado_pat')?.trim();
  if (fromSetting) return { value: fromSetting, source: 'setting' };
  return { value: undefined, source: 'none' };
}

/** A token is letters, digits and a few URL-safe marks. Anything else is a paste mistake. */
function looksLikeToken(value: string): boolean {
  return /^[A-Za-z0-9._~+/=-]{20,}$/.test(value);
}

/**
 * Save a new token: Keychain when there is one (and clear the plain-text copy),
 * otherwise the settings file. Returns where it went.
 *
 * The token goes to `security` on its standard input, not on the command line,
 * so it never shows up in the process list.
 */
export function saveToken(value: string): 'keychain' | 'setting' {
  if (!looksLikeToken(value)) throw new Error("That doesn't look like a token. Copy it again from Azure DevOps.");
  if (keychainAvailable()) {
    const r = spawnSync('security', ['-i'], {
      input: `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w "${value}"\n`,
      encoding: 'utf8',
    });
    if (r.status === 0 && readKeychainFresh() === value) {
      setSetting('ado_pat', '');
      return 'keychain';
    }
  }
  setSetting('ado_pat', value);
  cache = null;
  return 'setting';
}

/** Move a token kept in the settings file into the Keychain. */
export function moveTokenToKeychain(): 'keychain' | 'setting' {
  const fromSetting = getSetting('ado_pat')?.trim();
  if (!fromSetting) throw new Error('There is no token in the settings file to move.');
  return saveToken(fromSetting);
}

function readKeychainFresh(): string | undefined {
  cache = null;
  return readKeychain();
}
