import { useState } from 'react';
import { DOCTOR_CHANGE_REASONS, DOCTOR_CHANGE_REASON_LABEL, type DoctorChangeReason } from '@infusion/shared-types';
import { ApiError } from '../../lib/api';
import { useActiveDoctors } from '../doctors/api';
import { useChangePatientDoctor } from './api';

/**
 * Reception's "change doctor" form, opened from the patient's details: the
 * new attending doctor and why (wrong doctor, doctor unavailable, a new
 * issue, other). The change and its reason appear in the history timeline.
 */
export function ChangeDoctorForm({
  patientId,
  currentDoctorId,
  onDone,
}: {
  patientId: string;
  currentDoctorId: string | null;
  onDone: () => void;
}) {
  const { data: doctors } = useActiveDoctors();
  const change = useChangePatientDoctor();
  const [doctorId, setDoctorId] = useState('');
  const [reason, setReason] = useState<DoctorChangeReason>('doctor_unavailable');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const choices = (doctors ?? []).filter((d) => d.isActive && d.id !== currentDoctorId);

  const save = async () => {
    setError('');
    if (!doctorId) return setError('Choose the new doctor.');
    if (reason === 'other' && !note.trim()) return setError('Say why the doctor is changing.');
    try {
      await change.mutateAsync({ id: patientId, input: { doctorId, reason, note: note.trim() || undefined } });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not change the doctor.');
    }
  };

  return (
    <div className="change-doctor patient-form">
      <label>
        New doctor
        <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
          <option value="">-- Select --</option>
          {choices.map((d) => (
            <option key={d.id} value={d.id}>
              Dr. {d.name}
              {d.specialty ? ` · ${d.specialty}` : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        Reason
        <select value={reason} onChange={(e) => setReason(e.target.value as DoctorChangeReason)}>
          {DOCTOR_CHANGE_REASONS.map((r) => (
            <option key={r} value={r}>
              {DOCTOR_CHANGE_REASON_LABEL[r]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Note {reason === 'other' ? '(required)' : '(optional)'}
        <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onDone} disabled={change.isPending}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={change.isPending}>
          {change.isPending ? 'Saving…' : 'Change doctor'}
        </button>
      </div>
    </div>
  );
}
