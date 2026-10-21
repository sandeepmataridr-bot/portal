import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/api';
import { useMedicines } from '../medicines/api';
import { useVerifyStep, type InfusionStep } from './api';

export function VerifyDispenseModal({
  step,
  patientId,
  onClose,
}: {
  step: InfusionStep;
  patientId: string;
  onClose: () => void;
}) {
  const { data: medicines } = useMedicines();
  const [dispensedMedicineId, setDispensedMedicineId] = useState('');
  const [dispensedVolumeMl, setDispensedVolumeMl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const verify = useVerifyStep(patientId);

  const activeMedicines = medicines?.filter((m) => m.status === 'ACTIVE') ?? [];

  const confirm = async () => {
    setError(null);
    try {
      await verify.mutateAsync({ stepId: step.id, dispensedMedicineId, dispensedVolumeMl: Number(dispensedVolumeMl) });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && typeof err.body.message === 'string') {
        setError(err.body.message);
      } else {
        setError((err as Error).message);
      }
    }
  };

  return (
    <Modal title="🧪 Verify Pharmacy Dispense" onClose={onClose}>
      <div className="patient-form">
        <p className="form-hint">
          Confirm what's actually being dispensed for Step {step.stepNumber} — this must match the ordered medicine and volume
          exactly, or the step is rejected.
        </p>
        <p className="form-hint">
          Ordered: <b>{step.medicine.name}</b> ({step.medicine.concentration}), {step.plannedVolumeMl} ml.
        </p>
        <label>
          Medicine Actually Being Dispensed
          <select value={dispensedMedicineId} onChange={(e) => setDispensedMedicineId(e.target.value)}>
            <option value="">-- Select --</option>
            {activeMedicines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.concentration}) {m.highAlert ? '⚠️ High Alert' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Dispensed Volume (ml)
          <input type="number" value={dispensedVolumeMl} onChange={(e) => setDispensedVolumeMl(e.target.value)} />
        </label>
        {error && <p className="form-error">❌ {error}</p>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={confirm} disabled={verify.isPending || !dispensedVolumeMl || !dispensedMedicineId}>
          {verify.isPending ? 'Verifying…' : '✅ Confirm Dispense'}
        </button>
      </div>
    </Modal>
  );
}
