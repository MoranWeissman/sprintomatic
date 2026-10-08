import { useEffect, useRef, useState } from 'react';
import {
  getSchedule,
  putSchedule,
  type CeremonyConfig,
  type CeremonyRecurrence,
  type CeremonySchedule,
} from '../lib/api';

interface ScheduleModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful save so the dashboard can refresh ceremony state. */
  onSaved: () => void;
}

const DAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
];
const WEEKS = [
  { value: 1 as const, label: '1' },
  { value: 2 as const, label: '2' },
];

export function ScheduleModal({ open, onClose, onSaved }: ScheduleModalProps) {
  const [schedule, setSchedule] = useState<CeremonySchedule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load schedule each time the modal opens (in case it changed elsewhere).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadError(null);
    setSaveError(null);
    getSchedule()
      .then(s => {
        if (!cancelled) setSchedule(s);
      })
      .catch(e => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const update = (id: CeremonyConfig['id'], patch: Partial<CeremonyConfig>) => {
    setSchedule(s =>
      s ? { ...s, ceremonies: s.ceremonies.map(c => (c.id === id ? { ...c, ...patch } : c)) } : s,
    );
  };
  const updateRecurrence = (id: CeremonyConfig['id'], patch: Partial<CeremonyRecurrence>) => {
    setSchedule(s =>
      s
        ? {
            ...s,
            ceremonies: s.ceremonies.map(c =>
              c.id === id ? { ...c, recurrence: { ...c.recurrence, ...patch } as CeremonyRecurrence } : c,
            ),
          }
        : s,
    );
  };

  const handleSave = async () => {
    if (!schedule) return;
    setSaving(true);
    setSaveError(null);
    try {
      await putSchedule(schedule);
      onSaved();
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="schedule-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="schedule-title"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="schedule-modal">
        <header className="schedule-modal-head">
          <div className="text">
            <h2 className="schedule-modal-title" id="schedule-title">Schedule</h2>
            <p className="schedule-modal-sub">When does each thing happen? You can edit this anytime.</p>
          </div>
          <button className="schedule-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="schedule-modal-body">
          {loadError && (
            <p className="schedule-error" role="alert">Could not load schedule: {loadError}</p>
          )}
          {schedule && schedule.ceremonies.map(c => (
            <div key={c.id} className={`schedule-row ${c.enabled ? '' : 'is-disabled'}`}>
              <div className="schedule-row-name">{c.label.toUpperCase()}</div>
              <div className="schedule-row-fields">
                {c.recurrence.kind === 'weekdays' ? (
                  <span className="static-label">weekdays</span>
                ) : (
                  <>
                    <PillSelect
                      label="day"
                      value={c.recurrence.dayOfWeek}
                      options={DAYS}
                      onChange={v => updateRecurrence(c.id, { dayOfWeek: v })}
                    />
                    <span className="label">week</span>
                    <PillSelect
                      label="week"
                      value={c.recurrence.weekOfSprint}
                      options={WEEKS}
                      onChange={v => updateRecurrence(c.id, { weekOfSprint: v as 1 | 2 })}
                    />
                  </>
                )}
                <span className="label">at</span>
                <TimeInput
                  value={c.recurrence.time}
                  onChange={v => updateRecurrence(c.id, { time: v })}
                />
              </div>
              <button
                className={`schedule-toggle ${c.enabled ? 'is-on' : ''}`}
                onClick={() => update(c.id, { enabled: !c.enabled })}
                aria-pressed={c.enabled}
                aria-label={c.enabled ? 'Disable' : 'Enable'}
              />
            </div>
          ))}
        </div>

        <footer className="schedule-modal-foot">
          <p className="schedule-modal-foot-note">
            {saveError
              ? <span role="alert" style={{ color: 'oklch(0.78 0.10 30)' }}>{saveError}</span>
              : 'Outlook integration coming soon — once you connect Outlook, these times can auto-fill from your calendar.'}
          </p>
          <div className="schedule-modal-foot-actions">
            <button className="schedule-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button
              className="schedule-btn-accent"
              onClick={handleSave}
              disabled={saving || !schedule}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/* ============================================================ */
/*  Inline editors                                                */
/* ============================================================ */

interface PillOption<T> {
  value: T;
  label: string;
}

function PillSelect<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: PillOption<T>[];
  onChange: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="schedule-pick" ref={rootRef}>
      <button
        type="button"
        className="schedule-pill"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(v => !v)}
      >
        <span>{selected?.label ?? ''}</span>
        <span className="chev">▾</span>
      </button>
      {open && (
        <ul className="schedule-pick-menu" role="listbox" aria-label={label}>
          {options.map(o => (
            <li key={String(o.value)}>
              <button
                role="option"
                aria-selected={o.value === value}
                className={`schedule-pick-opt ${o.value === value ? 'is-active' : ''}`}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TimeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (/^\d{1,2}:\d{2}$/.test(draft)) {
      const [h, m] = draft.split(':').map(Number);
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        const normalized = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        if (normalized !== value) onChange(normalized);
        return;
      }
    }
    setDraft(value);
  };

  return editing ? (
    <input
      ref={inputRef}
      className="schedule-time"
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setEditing(false);
          setDraft(value);
        }
      }}
      inputMode="numeric"
      placeholder="HH:MM"
    />
  ) : (
    <button
      type="button"
      className="schedule-time"
      onClick={() => setEditing(true)}
      title="Click to edit"
    >
      {value}
    </button>
  );
}
