import { useEffect, useState } from 'react';
import {
  checkBoard,
  getSettings,
  moveTokenToKeychain,
  putSettings,
  type ApiBoardCheck,
  type ApiSetting,
  type ApiSettings,
} from '../lib/api';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful save so the dashboard can reload. */
  onSaved: () => void;
}

const GROUPS: { id: ApiSetting['group']; title: string }[] = [
  { id: 'week', title: 'Your week' },
  { id: 'board', title: 'Your board' },
  { id: 'pages', title: 'Pages' },
  { id: 'other', title: 'Other' },
];

const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "8.5" → "08:30". The server takes either form back. */
function hourText(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  const h = Math.floor(n);
  const m = Math.round((n - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** What the form starts from: the value in use, or the default when nothing is set. */
function startingValue(s: ApiSetting): string {
  const v = s.value ?? s.defaultValue ?? '';
  return s.kind === 'hour' && v !== '' ? hourText(v) : v;
}

function tokenWhere(s: ApiSetting): string {
  if (s.source === 'keychain') return 'Saved in your Mac Keychain. Leave this empty to keep it.';
  if (s.source === 'setting') return 'Saved in the settings file. Leave this empty to keep it.';
  return 'Not saved yet.';
}

export function SettingsModal({ open, onClose, onSaved }: SettingsModalProps) {
  const [data, setData] = useState<ApiSettings | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [start, setStart] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ message: string; key?: string } | null>(null);
  const [busy, setBusy] = useState<'save' | 'check' | 'move' | null>(null);
  const [check, setCheck] = useState<ApiBoardCheck | null>(null);

  const take = (next: ApiSettings) => {
    const values = Object.fromEntries(next.settings.map(s => [s.key, startingValue(s)]));
    setData(next);
    setStart(values);
    setDraft(values);
  };

  // Load each time it opens, in case something changed in a chat meanwhile.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadError(null);
    setSaveError(null);
    setCheck(null);
    getSettings()
      .then(s => { if (!cancelled) take(s); })
      .catch(e => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const set = (key: string, value: string) => setDraft(d => ({ ...d, [key]: value }));
  const changed = Object.keys(draft).filter(k => draft[k] !== start[k]);
  const usesToken = draft.ado_access_mode === 'api';

  const runCheck = async () => {
    setBusy('check');
    setCheck(null);
    try {
      setCheck(await checkBoard());
    } catch (e) {
      setCheck({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async () => {
    if (changed.length === 0) return onClose();
    setBusy('save');
    setSaveError(null);
    try {
      const boardChanged = changed.some(k => data?.settings.find(s => s.key === k)?.group === 'board');
      take(await putSettings(Object.fromEntries(changed.map(k => [k, draft[k]]))));
      onSaved();
      setBusy(null);
      // A new board address or token: try it right away, so a typo shows now
      // and not on the next refresh.
      if (boardChanged) await runCheck();
      else onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSaveError({ message, key: (e as { key?: string }).key });
      setBusy(null);
    }
  };

  const handleMove = async () => {
    setBusy('move');
    try {
      take(await moveTokenToKeychain());
    } catch (e) {
      setSaveError({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const field = (s: ApiSetting) => {
    const value = draft[s.key] ?? '';
    const disabled = s.locked || busy !== null;
    switch (s.kind) {
      case 'days': {
        const on = new Set(value.split(',').filter(Boolean).map(Number));
        const toggle = (d: number) => {
          const next = new Set(on);
          if (next.has(d)) next.delete(d); else next.add(d);
          set(s.key, [...next].sort((a, b) => a - b).join(','));
        };
        return (
          <div className="settings-days">
            {WEEK.map((name, d) => (
              <button
                key={name}
                type="button"
                className={`settings-day ${on.has(d) ? 'is-on' : ''}`}
                aria-pressed={on.has(d)}
                disabled={disabled}
                onClick={() => toggle(d)}
              >
                {name}
              </button>
            ))}
          </div>
        );
      }
      case 'choice':
        return (
          <div className="settings-seg">
            {s.choices!.map(c => (
              <button
                key={c.value}
                type="button"
                className={`settings-seg-opt ${value === c.value ? 'is-on' : ''}`}
                aria-pressed={value === c.value}
                disabled={disabled}
                onClick={() => set(s.key, c.value)}
              >
                {c.label}
              </button>
            ))}
          </div>
        );
      case 'secret':
        return (
          <input
            className="settings-input"
            type="password"
            autoComplete="off"
            value={value}
            disabled={disabled}
            placeholder={tokenWhere(s)}
            onChange={e => set(s.key, e.target.value)}
          />
        );
      default:
        return (
          <input
            className={`settings-input ${s.kind === 'text' ? '' : 'is-short'}`}
            value={value}
            disabled={disabled}
            inputMode={s.kind === 'number' ? 'decimal' : undefined}
            placeholder={s.kind === 'hour' ? 'HH:MM' : `Empty = ${s.defaultLabel}`}
            onChange={e => set(s.key, e.target.value)}
          />
        );
    }
  };

  const row = (s: ApiSetting) => {
    // The token only matters when the board is reached with a token.
    if (s.kind === 'secret' && !usesToken) return null;
    return (
      <div key={s.key} className={`settings-row ${saveError?.key === s.key ? 'has-error' : ''}`}>
        <div className="settings-row-name">{s.label}</div>
        <div className="settings-row-field">
          {field(s)}
          <p className="settings-row-help">
            {s.locked
              ? <>Set by the <code>{s.env}</code> environment variable, so it can't be changed here.</>
              : s.help}
          </p>
          {s.kind === 'secret' && data?.tokenCanMoveToKeychain && (
            <button type="button" className="settings-link" onClick={handleMove} disabled={busy !== null}>
              {busy === 'move' ? 'Moving…' : 'Move it to the Keychain'}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      className="schedule-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="schedule-modal settings-modal">
        <header className="schedule-modal-head">
          <div className="text">
            <h2 className="schedule-modal-title" id="settings-title">Settings</h2>
            <p className="schedule-modal-sub">Your week, your board, and which pages you use.</p>
          </div>
          <button className="schedule-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="schedule-modal-body">
          {loadError && <p className="schedule-error" role="alert">Could not load settings: {loadError}</p>}
          {data && GROUPS.map(g => (
            <section key={g.id} className="settings-group">
              <h3 className="settings-group-title">{g.title}</h3>
              {data.settings.filter(s => s.group === g.id).map(row)}
            </section>
          ))}
          {data && (
            <p className="settings-note">
              Open AI chats keep the old values until you reload sprintomatic in them.
            </p>
          )}
        </div>

        <footer className="schedule-modal-foot">
          <div className="schedule-modal-foot-note">
            {saveError ? (
              <span role="alert" className="settings-bad">{saveError.message}</span>
            ) : check ? (
              <CheckResult check={check} />
            ) : (
              <button type="button" className="settings-link" onClick={runCheck} disabled={busy !== null || !data}>
                {busy === 'check' ? 'Checking…' : 'Check the connection'}
              </button>
            )}
          </div>
          <div className="schedule-modal-foot-actions">
            <button className="schedule-btn-ghost" onClick={onClose} disabled={busy === 'save'}>
              {check?.ok ? 'Close' : 'Cancel'}
            </button>
            <button className="schedule-btn-accent" onClick={handleSave} disabled={busy !== null || !data || changed.length === 0}>
              {busy === 'save' ? 'Saving…' : busy === 'check' ? 'Checking…' : 'Save'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function CheckResult({ check }: { check: ApiBoardCheck }) {
  if (!check.ok) {
    return (
      <span role="alert" className="settings-bad">
        Couldn't reach the board. {check.error}{check.fix ? ` ${check.fix}` : ''}
      </span>
    );
  }
  const st = check.states;
  return (
    <span className="settings-good">
      Connected.
      {st && (st.waiting || st.going || st.done) && (
        <> Your tasks move through {[st.waiting, st.going, st.done].filter(Boolean).join(' → ')}.</>
      )}
      {st && !st.blocked && <> Your board has no Blocked state for tasks, so blocking a task won't work.</>}
    </span>
  );
}
