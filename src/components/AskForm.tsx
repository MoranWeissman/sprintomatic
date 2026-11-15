import { useState, type ReactNode } from 'react';

/**
 * A small in-page form that asks one thing (hours, a reason) — used instead of
 * the browser's prompt box. `check` returns an error to show, or null when the
 * answer is fine.
 */
export function AskForm({
  label,
  initial = '',
  placeholder,
  submitText,
  inputMode,
  busy = false,
  check,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial?: string;
  placeholder?: string;
  submitText: string;
  inputMode?: 'decimal' | 'text';
  /** True while the answer is being saved: the buttons wait, so it can't go twice. */
  busy?: boolean;
  check?: (value: string) => string | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="ask-form"
      onSubmit={e => {
        e.preventDefault();
        if (busy) return;
        const v = value.trim();
        const problem = check ? check(v) : v ? null : 'Please fill this in.';
        if (problem) return setError(problem);
        onSubmit(v);
      }}
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <label className="ask-form-label">
        <span>{label}</span>
        <input
          autoFocus
          className="ask-form-input"
          value={value}
          placeholder={placeholder}
          inputMode={inputMode}
          onChange={e => {
            setValue(e.target.value);
            setError(null);
          }}
        />
      </label>
      {error && <span className="ask-form-error">{error}</span>}
      <span className="ask-form-buttons">
        <button type="submit" className="ask-form-ok" disabled={busy}>{submitText}</button>
        <button type="button" className="ask-form-cancel" onClick={onCancel}>Cancel</button>
      </span>
    </form>
  );
}

/**
 * The same small in-page form, for a plain yes or no — used instead of the
 * browser's confirm box.
 */
export function AskYesNo({
  question,
  yesText,
  busy = false,
  onYes,
  onCancel,
}: {
  question: ReactNode;
  yesText: string;
  busy?: boolean;
  onYes: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="ask-form"
      onSubmit={e => {
        e.preventDefault();
        if (!busy) onYes();
      }}
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="ask-form-label">{question}</div>
      <span className="ask-form-buttons">
        <button type="submit" autoFocus className="ask-form-ok" disabled={busy}>{yesText}</button>
        <button type="button" className="ask-form-cancel" onClick={onCancel}>Cancel</button>
      </span>
    </form>
  );
}
