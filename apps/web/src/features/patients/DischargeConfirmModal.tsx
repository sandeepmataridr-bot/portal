import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { useDischargePatient } from './api';

export function DischargeConfirmModal({ patientId, patientName, onClose }: { patientId: string; patientName: string; onClose: () => void }) {
  const [remarks, setRemarks] = useState('');
  const discharge = useDischargePatient();

  const confirm = async () => {
    await discharge.mutateAsync({ id: patientId, input: { remarks: remarks || undefined } });
    onClose();
  };

  return (
    <Modal title="Discharge Patient" onClose={onClose}>
      <div className="patient-form">
        <p>
          Confirm discharge for <b>{patientName}</b>?
        </p>
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
        <button type="button" className="btn-danger" onClick={confirm} disabled={discharge.isPending}>
          {discharge.isPending ? 'Confirming…' : 'Confirm'}
        </button>
      </div>
    </Modal>
  );
}
