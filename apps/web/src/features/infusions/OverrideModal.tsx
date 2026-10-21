import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/api';
import { useOverrideStep, type InfusionStep } from './api';

export function OverrideModal({ step, patientId, onClose }: { step: InfusionStep; patientId: string; onClose: () => void }) {
  const [targetStatus, setTargetStatus] = useState<'RUNNING' | 'CANCELLED'>('RUNNING');
  const [reason, setReason] = useState('');
  const [violations, setViolations] = useState<string[]>([]);
  const override = useOverrideStep(patientId);

  const confirm = async () => {
    setViolations([]);
    try {
      await override.mutateAsync({ stepId: step.id, targetStatus, reason });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.body.violations)) {
        setViolations(err.body.violations as string[]);
      } else {
        setViolations([(err as Error).message]);
      }
    }
  };

  return (
    <Modal title="⚠️ Override Step" onClose={onClose}>
      <div className="patient-form">
        <p className="form-hint">
          Force Step {step.stepNumber} — {step.medicine.name} — past a blocked transition. The absolute dosage/rate ceiling can
          never be overridden, no matter the reason given.
        </p>
        <label>
          Force To
          <select value={targetStatus} onChange={(e) => setTargetStatus(e.target.value as 'RUNNING' | 'CANCELLED')}>
            <option value="RUNNING">Running</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </label>
        <label>
          Justification * (min 10 characters)
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Specific clinical justification, required" />
        </label>
        {violations.length > 0 && (
          <div className="form-error">
            {violations.map((v, i) => (
              <p key={i}>❌ {v}</p>
            ))}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Back
        </button>
        <button type="button" className="btn-danger" onClick={confirm} disabled={override.isPending || reason.trim().length < 10}>
          {override.isPending ? 'Overriding…' : '⚠️ Confirm Override'}
        </button>
      </div>
    </Modal>
  );
}
