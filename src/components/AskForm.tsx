import { useState } from 'react';

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
  check,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial?: string;
  placeholder?: string;
  submitText: string;
  inputMode?: 'decimal' | 'text';
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
        <button type="submit" className="ask-form-ok">{submitText}</button>
        <button type="button" className="ask-form-cancel" onClick={onCancel}>Cancel</button>
      </span>
    </form>
  );
}
