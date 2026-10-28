import { useState } from 'react';
import { DISCHARGE_OUTCOMES, DISCHARGE_OUTCOME_LABEL, type DischargeOutcome } from '@infusion/shared-types';
import { Modal } from '../../components/Modal';
import { useDischargePatient } from './api';

/** Discharge with how the patient left (required): it goes in the timeline and the doctor's counts. */
export function DischargeConfirmModal({ patientId, patientName, onClose }: { patientId: string; patientName: string; onClose: () => void }) {
  const [outcome, setOutcome] = useState<DischargeOutcome | ''>('');
  const [remarks, setRemarks] = useState('');
  const discharge = useDischargePatient();

  const confirm = async () => {
    if (!outcome) return;
    await discharge.mutateAsync({ id: patientId, input: { outcome, remarks: remarks || undefined } });
    onClose();
  };

  return (
    <Modal title="Discharge Patient" onClose={onClose}>
      <div className="patient-form">
        <p>
          Confirm discharge for <b>{patientName}</b>?
        </p>
        <label>
          Outcome *
          <select value={outcome} onChange={(e) => setOutcome(e.target.value as DischargeOutcome | '')}>
            <option value="">-- Select --</option>
            {DISCHARGE_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {DISCHARGE_OUTCOME_LABEL[o]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Remarks
          <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Enter remarks (optional)" rows={3} />
        </label>
        {discharge.isError && <p className="form-error">❌ {(discharge.error as Error).message}</p>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn-danger" onClick={() => void confirm()} disabled={!outcome || discharge.isPending}>
          {discharge.isPending ? 'Confirming…' : 'Confirm'}
        </button>
      </div>
    </Modal>
  );
}
