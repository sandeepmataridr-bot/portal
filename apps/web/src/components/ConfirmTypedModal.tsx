import { useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import { ApiError } from '../lib/api';

const WORD = 'CONFIRM';

/**
 * For actions that cut a machine off or change what it is attached to (issue
 * a credential, unassign a machine): the user must type CONFIRM before the
 * action button works, so a single stray click never does it.
 */
export function ConfirmTypedModal({
  title,
  children,
  action,
  busyLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  /** What will happen, shown above the box. */
  children: ReactNode;
  /** The action button, e.g. "Issue new credential". */
  action: string;
  busyLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = typed.trim() === WORD;

  const submit = async () => {
    if (!ready || busy) return;
    setError('');
    setBusy(true);
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <div className="credential-confirm">
        {children}
        <label>
          <span>
            Type <strong>{WORD}</strong> to continue
          </span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            aria-describedby="confirm-typed-hint"
          />
        </label>
        <p id="confirm-typed-hint" className="form-hint">
          Capital letters, exactly as shown.
        </p>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-danger" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? busyLabel : action}
          </button>
        </div>
      </div>
    </Modal>
  );
}
