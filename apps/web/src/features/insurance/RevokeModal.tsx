import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { useClaimRevoke } from './api';

export function RevokeModal({ claimId, onClose }: { claimId: string; onClose: () => void }) {
  const [remarks, setRemarks] = useState('');
  const revoke = useClaimRevoke();

  const submit = async () => {
    await revoke.mutateAsync({ id: claimId, input: { remarks: remarks || undefined } });
    onClose();
  };

  return (
    <Modal title="Revoke Decision" onClose={onClose}>
      <div className="patient-form">
        <p>
          Are you sure you want to revoke this decision? The claim will be set back to <b>Under Review</b>.
        </p>
        <label>
          Remarks (optional)
          <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Reason for revocation..." rows={3} />
        </label>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn-revoke" onClick={submit} disabled={revoke.isPending}>
          Revoke
        </button>
      </div>
    </Modal>
  );
}
