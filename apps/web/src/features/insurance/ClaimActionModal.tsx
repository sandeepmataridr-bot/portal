import { useState } from 'react';
import type { ClaimDecisionAction } from '@infusion/shared-types';
import { Modal } from '../../components/Modal';
import { useClaimDecision, useRejectionReasons } from './api';

export function ClaimActionModal({
  claimId,
  action,
  onClose,
}: {
  claimId: string;
  action: ClaimDecisionAction;
  onClose: () => void;
}) {
  const { data: reasons } = useRejectionReasons();
  const decide = useClaimDecision();
  const [reasonCode, setReasonCode] = useState('');
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isReject = action === 'Reject';

  const submit = async () => {
    if (isReject && !reasonCode) return setError('Please select a rejection reason.');
    if (isReject && reasonCode === 'R020' && !remarks) return setError('Please specify the reason for "Other".');
    setError(null);
    try {
      await decide.mutateAsync({ id: claimId, input: { action, reasonCode: isReject ? reasonCode : undefined, remarks: remarks || undefined } });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title={action} onClose={onClose}>
      <div className="patient-form">
        {isReject ? (
          <>
            <p>Select a rejection reason:</p>
            <label>
              Reason Code
              <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                <option value="">-- Select --</option>
                {reasons?.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.code} - {r.description}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {reasonCode === 'R020' ? 'Specify Reason' : 'Remarks (optional)'}
              <textarea
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder={reasonCode === 'R020' ? 'Enter reason details...' : 'Any additional remarks...'}
                rows={3}
              />
            </label>
          </>
        ) : (
          <>
            <p>{action} this claim?</p>
            <label>
              {action === 'Request Documents' ? 'Specify documents required' : 'Remarks (optional)'}
              <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Enter remarks..." rows={3} />
            </label>
          </>
        )}

        {error && <p className="form-error">❌ {error}</p>}
      </div>

      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className={isReject ? 'btn-danger' : 'btn-primary'} onClick={submit} disabled={decide.isPending}>
          {isReject ? 'Reject' : 'Confirm'}
        </button>
      </div>
    </Modal>
  );
}
