import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/api';
import { useMedicines } from '../medicines/api';
import { useReconciliationQueue, useResolveReconciliationItem, type ReconciliationItem } from './api';

function ItemDetail({ item, onClose }: { item: ReconciliationItem; onClose: () => void }) {
  const { data: medicines } = useMedicines();
  const [resolution, setResolution] = useState('');
  const [linkedMedicineId, setLinkedMedicineId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const resolve = useResolveReconciliationItem();

  const activeMedicines = medicines?.filter((m) => m.status === 'ACTIVE') ?? [];

  const confirm = async () => {
    setError(null);
    try {
      await resolve.mutateAsync({
        id: item.id,
        input: { resolution, linkedMedicineId: item.kind === 'medicine_match' && linkedMedicineId ? linkedMedicineId : undefined },
      });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  return (
    <Modal title={item.kind === 'patient_duplicate' ? '👥 Possible Duplicate Patient' : '💊 Unresolved Medicine'} onClose={onClose}>
      <div className="patient-form">
        <p className="form-hint">
          Reported by machine <b>{item.machine.machineCode}</b> — {new Date(item.createdAt).toLocaleString()}
        </p>
        <div className="detail-grid">
          {Object.entries(item.rawPayload).map(([k, v]) => (
            <div key={k}>
              <b>{k}</b>
              <p>{String(v)}</p>
            </div>
          ))}
        </div>

        {item.candidates && item.candidates.length > 0 && (
          <>
            <h4 className="form-section-title">Possible matches</h4>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Match</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {item.candidates.map((c) => (
                  <tr key={c.id}>
                    <td>{c.label}</td>
                    <td>{Math.round(c.score * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {item.kind === 'medicine_match' && (
          <label>
            Link to catalog medicine (optional)
            <select value={linkedMedicineId} onChange={(e) => setLinkedMedicineId(e.target.value)}>
              <option value="">-- Leave unlinked --</option>
              {activeMedicines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.concentration})
                </option>
              ))}
            </select>
          </label>
        )}

        <label>
          Resolution note *
          <textarea value={resolution} onChange={(e) => setResolution(e.target.value)} rows={3} placeholder="What did you decide, and why?" />
        </label>
        {error && <p className="form-error">❌ {error}</p>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Back
        </button>
        <button type="button" className="btn-primary" onClick={confirm} disabled={resolve.isPending || resolution.trim().length < 3}>
          {resolve.isPending ? 'Saving…' : 'Resolve'}
        </button>
      </div>
    </Modal>
  );
}

export function ReviewQueueModal({ onClose }: { onClose: () => void }) {
  const { data: items } = useReconciliationQueue('pending');
  const [selected, setSelected] = useState<ReconciliationItem | null>(null);

  return (
    <Modal title="🔍 Pending Reviews" onClose={onClose} wide>
      <table className="data-table">
        <thead>
          <tr>
            <th>Kind</th>
            <th>Machine</th>
            <th>Reported</th>
            <th>Candidates</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items?.length === 0 && (
            <tr>
              <td colSpan={5}>Nothing pending review.</td>
            </tr>
          )}
          {items?.map((item) => (
            <tr key={item.id}>
              <td>{item.kind === 'patient_duplicate' ? '👥 Possible duplicate patient' : '💊 Unresolved medicine'}</td>
              <td>{item.machine.machineCode}</td>
              <td>{new Date(item.createdAt).toLocaleString()}</td>
              <td>{item.candidates?.length ?? 0}</td>
              <td>
                <button type="button" className="link-button" onClick={() => setSelected(item)}>
                  Review
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && <ItemDetail item={selected} onClose={() => setSelected(null)} />}
    </Modal>
  );
}
