/**
 * `npm run setup` — first-time setup, one question at a time.
 *
 * Asks how to reach the board, the board details, the user's week and which
 * feature pages they use, saves
 * the answers through the same list the settings screen uses
 * (server/settings-registry.ts), checks the connection, reads the board's
 * state names, and prints the one line that adds sprintomatic to Claude Code.
 *
 * Press Enter to keep what is shown in [brackets]. Safe to run again.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSettings, saveSettings, SettingError, type SettingView } from '../server/settings-registry';
import { invalidateAdoConfig } from '../server/config';
import { resetAdoClient } from '../server/ado-client';
import { probeBoardStates } from '../server/state-probe';
import { hourLabel, workingDaysLabel } from '../server/user-config';

const rl = createInterface({ input: stdin, output: stdout });
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function shown(s: SettingView): string {
  const v = s.value ?? s.defaultValue;
  if (v == null || v === '') return '';
  if (s.kind === 'days') return workingDaysLabel(new Set(v.split(',').map(Number)));
  if (s.kind === 'hour') return hourLabel(Number(v));
  if (s.kind === 'choice') return s.choices?.find(c => c.value === v)?.label ?? v;
  return v;
}

/** Ask one setting until the answer is accepted. Enter keeps what is there. */
async function ask(key: string, hint = ''): Promise<void> {
  const s = listSettings().find(x => x.key === key)!;
  if (s.locked) {
    console.log(`  ${s.label}: set by ${s.env}, skipping.`);
    return;
  }
  for (;;) {
    let prompt = `  ${s.label}${hint ? ` (${hint})` : ''}`;
    if (s.kind === 'secret') {
      prompt += s.source === 'default' ? ': ' : ' [saved, Enter keeps it]: ';
    } else {
      const now = shown(s);
      prompt += now ? ` [${now}]: ` : ': ';
    }
    const answer = (await rl.question(prompt)).trim();
    if (answer === '') return;
    let value = answer;
    if (s.kind === 'choice') {
      const pick = s.choices!.find((c, i) => answer === String(i + 1) || answer.toLowerCase() === c.value);
      if (!pick) { console.log(`    Type ${s.choices!.map((c, i) => `${i + 1} for ${c.label}`).join(', ')}.`); continue; }
      value = pick.value;
    }
    try {
      saveSettings({ [key]: value });
      return;
    } catch (err) {
      if (err instanceof SettingError) { console.log(`    ${err.message}`); continue; }
      throw err;
    }
  }
}

async function main() {
  console.log('\nsprintomatic setup. Press Enter to keep what is in [brackets].\n');

  console.log('How should sprintomatic reach your Azure DevOps board?');
  console.log('  1 = the az command (you are signed in with az login)');
  console.log('  2 = a personal access token (no Azure CLI needed)');
  await ask('ado_access_mode', '1 or 2');
  const mode = listSettings().find(s => s.key === 'ado_access_mode')!;
  const usesToken = (mode.value ?? mode.defaultValue) === 'api';

  console.log('\nYour board.' + (usesToken ? '' : ' Leave any of these empty to use what az already knows.'));
  await ask('ado_org', 'like https://dev.azure.com/your-org');
  await ask('ado_project');
  await ask('ado_team');
  await ask('ado_user', 'your sign-in email');
  if (usesToken) {
    console.log('  The token is kept in the Mac Keychain when there is one. Typing it shows on screen.');
    await ask('ado_pat', 'needs work item read and write');
  }

  console.log('\nYour week.');
  await ask('working_days', 'like Mon-Fri or Sun-Thu');
  await ask('workday_hours');
  await ask('workday_start_hour', 'like 08:00');
  await ask('workday_end_hour', 'like 18:00');
  console.log('  Meetings you said "maybe" to: 1 = ignore them, 2 = count half, 3 = count in full');
  await ask('tentative_weight', '1, 2 or 3');

  console.log('\nFeature work. Some people work out a problem first (discovery) and write a');
  console.log('design before the stories. Turn on what you do. Both can stay off.');
  console.log('  1 = on, 2 = off');
  await ask('use_discovery', '1 or 2');
  await ask('use_design', '1 or 2');

  console.log('\nChecking the connection…');
  invalidateAdoConfig();
  resetAdoClient();
  try {
    const st = await probeBoardStates();
    console.log(`  Connected. Your tasks move through ${[st.waiting, st.going, st.done].filter(Boolean).join(' → ')}.`);
    if (!st.blocked) console.log("  Your board has no Blocked state for tasks, so blocking a task won't work.");
  } catch (err) {
    const e = err as Error & { azMessage?: string; azFix?: string | null };
    console.log(`  Couldn't reach the board: ${e.azMessage ?? e.message}`);
    if (e.azFix) console.log(`  ${e.azFix}`);
    console.log('  Fix that and run `npm run setup` again. Your answers so far are saved.');
  }

  console.log('\nTo use it from Claude Code, run this once:\n');
  console.log(`  claude mcp add -s user sprintomatic -- npm --prefix "${repo}" run mcp --silent\n`);
  console.log('Then `npm start` opens the dashboard on http://localhost:7777.');
  console.log('You can change all of this later under Settings in the dashboard.\n');
}

main()
  .catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
