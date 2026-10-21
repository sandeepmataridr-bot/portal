import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/api';
import { usePatients } from '../patients/api';
import { useTagPatientMachine } from '../patients/api';

export function AssignPatientModal({
  machineId,
  machineCode,
  onClose,
}: {
  machineId: string;
  machineCode: string;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const { data: patients } = usePatients(search);
  const tag = useTagPatientMachine();
  const [error, setError] = useState<string | null>(null);

  const assign = async (patientId: string) => {
    setError(null);
    try {
      await tag.mutateAsync({ id: patientId, machineId });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const activePatients = patients?.filter((p) => !p.discharged) ?? [];

  return (
    <Modal title={`🖥️ Assign Patient to ${machineCode}`} onClose={onClose}>
      <div className="patient-form">
        <label>
          Search Patient
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, IP..."
            autoFocus
          />
        </label>
        {error && <p className="form-error">❌ {error}</p>}
        <table className="data-table">
          <thead>
            <tr>
              <th>IP</th>
              <th>Name</th>
              <th>Doctor</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {activePatients.length === 0 && (
              <tr>
                <td colSpan={4}>No active patients found.</td>
              </tr>
            )}
            {activePatients.map((p) => (
              <tr key={p.id}>
                <td>{p.ipNumber}</td>
                <td>{p.fullName}</td>
                <td>{p.doctorName ?? '—'}</td>
                <td>
                  <button type="button" className="btn-primary" onClick={() => assign(p.id)} disabled={tag.isPending}>
                    Assign
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
