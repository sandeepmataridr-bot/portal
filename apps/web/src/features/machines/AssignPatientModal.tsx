import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/api';
import { usePatients } from '../patients/api';
import { useTagPatientMachine } from '../patients/api';

/**
 * Tags a patient to a machine. Only patients in the machine's room are
 * offered: a machine is never tagged to a patient in another room.
 */
export function AssignPatientModal({
  machineId,
  machineCode,
  room,
  onClose,
}: {
  machineId: string;
  machineCode: string;
  room: { id: string; name: string } | null;
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

  const admitted = patients?.filter((p) => !p.discharged) ?? [];
  const activePatients = room ? admitted.filter((p) => p.room?.id === room.id) : [];
  const elsewhere = admitted.length - activePatients.length;

  return (
    <Modal title={`🖥️ Assign Patient to ${machineCode}`} onClose={onClose}>
      <div className="patient-form">
        <p className="form-hint">
          {room
            ? `${machineCode} is in ${room.name}. Only patients in ${room.name} can be tagged to it.`
            : `${machineCode} has no room yet. Move it to a room first.`}
        </p>
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
                <td colSpan={4}>{room ? `No admitted patients in ${room.name}.` : "Set the machine's room first."}</td>
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
        {elsewhere > 0 && room && (
          <p className="form-hint">
            {elsewhere} patient{elsewhere === 1 ? '' : 's'} in other rooms can't be tagged to {machineCode}. Move the patient or the machine
            first.
          </p>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
