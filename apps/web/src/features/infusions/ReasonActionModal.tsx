import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/api';
import { useRejectStep, useCancelStep, type InfusionStep } from './api';

export function ReasonActionModal({
  step,
  patientId,
  action,
  onClose,
}: {
  step: InfusionStep;
  patientId: string;
  action: 'reject' | 'cancel';
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reject = useRejectStep(patientId);
  const cancel = useCancelStep(patientId);
  const mutation = action === 'reject' ? reject : cancel;

  const confirm = async () => {
    setError(null);
    try {
      await mutation.mutateAsync({ stepId: step.id, reason });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && typeof err.body.message === 'string') {
        setError(err.body.message);
      } else {
        setError((err as Error).message);
      }
    }
  };

  const title = action === 'reject' ? '🚫 Reject Step' : '✖ Cancel Step';

  return (
    <Modal title={title} onClose={onClose}>
      <div className="patient-form">
        <p>
          {action === 'reject' ? 'Reject' : 'Cancel'} Step {step.stepNumber} — {step.medicine.name} ({step.plannedVolumeMl} ml)?
        </p>
        <label>
          Reason *
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Required — explain why" />
        </label>
        {error && <p className="form-error">❌ {error}</p>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Back
        </button>
        <button type="button" className="btn-danger" onClick={confirm} disabled={mutation.isPending || reason.trim().length < 3}>
          {mutation.isPending ? 'Submitting…' : `Confirm ${action === 'reject' ? 'Reject' : 'Cancel'}`}
        </button>
      </div>
    </Modal>
  );
}
