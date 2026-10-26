import { useState } from 'react';
import { ApiError } from '../../lib/api';
import { useMovePatient, useRooms } from '../rooms/api';
import type { PatientDetail } from './api';

/**
 * Reception moves a patient to another room. The machines attached to the
 * patient move with them (a machine and its patient are always in the same
 * room); the confirmation lists them, and the timeline records it.
 */
export function MoveRoomForm({ patient, onDone }: { patient: PatientDetail; onDone: () => void }) {
  const { data: rooms } = useRooms();
  const move = useMovePatient();
  const [roomId, setRoomId] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const machines = patient.machineAssignments.map((a) => a.machine.machineCode);
  const target = rooms?.find((r) => r.id === roomId);

  const save = async () => {
    setError('');
    if (!roomId) return setError('Choose the new room.');
    if (machines.length && !confirming) return setConfirming(true);
    try {
      await move.mutateAsync({ patientId: patient.id, roomId, note: note.trim() || undefined });
      onDone();
    } catch (e) {
      setConfirming(false);
      setError(e instanceof ApiError ? e.message : 'Could not move the patient.');
    }
  };

  return (
    <div className="change-doctor patient-form">
      <label>
        New room
        <select value={roomId} onChange={(e) => (setRoomId(e.target.value), setConfirming(false))}>
          <option value="">-- Select --</option>
          {rooms
            ?.filter((r) => r.id !== patient.room?.id)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        Note (optional)
        <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {confirming && (
        <p className="links-confirm">
          {machines.join(', ')} {machines.length === 1 ? 'is' : 'are'} attached to {patient.fullName} and will move to{' '}
          <b>{target?.name}</b> too. Press Move again to confirm.
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onDone} disabled={move.isPending}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={move.isPending}>
          {confirming ? 'Move — confirm' : 'Move'}
        </button>
      </div>
    </div>
  );
}
