'use client';

import { useCallback, useEffect, useRef } from 'react';
import styles from '../app/auth-glass.module.css';

/**
 * A segmented one-time-code field.
 *
 * The segments are presentation; the value is one string the caller owns.
 * That matters for the paste case — people copy the whole code out of their
 * authenticator, and a per-box array would drop everything after the first
 * character. Pasting anywhere in the row fills the row.
 *
 * Keyboard behaviour is the part that is usually wrong: Backspace on an
 * empty box steps back and clears the previous one, arrows move without
 * editing, and typing over a filled box replaces rather than appends.
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  length = 6,
  disabled = false,
  label = 'One-time code',
}: {
  value: string;
  onChange: (next: string) => void;
  /** Fired once the last empty slot is filled, so the form can self-submit. */
  onComplete?: (code: string) => void;
  length?: number;
  disabled?: boolean;
  label?: string;
}): React.JSX.Element {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const fired = useRef(false);

  const digits = Array.from({ length }, (_, i) => value[i] ?? '');
  const focusAt = (i: number): void => {
    boxes.current[Math.max(0, Math.min(length - 1, i))]?.focus();
  };

  const set = useCallback(
    (next: string) => {
      onChange(next.slice(0, length));
    },
    [length, onChange],
  );

  // Auto-submit belongs here rather than in an onChange branch: it must fire
  // for a paste and for the final keystroke alike, and exactly once.
  useEffect(() => {
    if (value.length === length && !fired.current) {
      fired.current = true;
      onComplete?.(value);
    }
    if (value.length < length) fired.current = false;
  }, [value, length, onComplete]);

  function handleInput(index: number, raw: string): void {
    const typed = raw.replace(/\D/g, '');
    if (!typed) return;
    const chars = value.split('');
    // Typing into a box replaces that slot; a multi-character insert (mobile
    // keyboards and autofill both do this) spills forward from it.
    for (let i = 0; i < typed.length && index + i < length; i += 1) {
      chars[index + i] = typed[i] as string;
    }
    const next = chars.join('').slice(0, length);
    set(next);
    focusAt(index + typed.length);
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const chars = value.split('');
      if (chars[index]) {
        chars[index] = '';
        set(chars.join('').replace(/\s+$/, ''));
        return;
      }
      if (index > 0) {
        chars[index - 1] = '';
        set(chars.join(''));
        focusAt(index - 1);
      }
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusAt(index - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusAt(index + 1);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>): void {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '');
    if (!pasted) return;
    e.preventDefault();
    set(pasted);
    focusAt(Math.min(pasted.length, length - 1));
  }

  return (
    <div className={styles.otpRow} role="group" aria-label={label}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={el => {
            boxes.current[i] = el;
          }}
          className={styles.otpBox}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          /* maxLength 1 would silently drop a paste or an autofill on some
             mobile keyboards, so the value is clamped in code instead. */
          aria-label={`${label}, digit ${i + 1} of ${length}`}
          data-filled={d ? 'true' : 'false'}
          value={d}
          disabled={disabled}
          autoFocus={i === 0}
          onChange={e => handleInput(i, e.target.value)}
          onKeyDown={e => handleKeyDown(i, e)}
          onPaste={handlePaste}
          onFocus={e => e.currentTarget.select()}
        />
      ))}
    </div>
  );
}
