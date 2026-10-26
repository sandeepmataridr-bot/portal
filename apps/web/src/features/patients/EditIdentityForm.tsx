import { useState } from 'react';
import { updatePatientIdentitySchema } from '@infusion/shared-types';
import { ApiError } from '../../lib/api';
import { useUpdatePatientIdentity, type PatientDetail } from './api';

/**
 * Reception's identity correction, opened from the patient's details. IP
 * number, full name and gender are shown but fixed: once registered they
 * never change. Every change is recorded in the history timeline (IDENTITY_UPDATE).
 */
export function EditIdentityForm({ patient, onDone }: { patient: PatientDetail; onDone: () => void }) {
  const update = useUpdatePatientIdentity();
  const [form, setForm] = useState({
    age: String(patient.age),
    mobile: patient.mobile,
    emergencyContact: patient.emergencyContact,
    aadhar: patient.aadhar,
    address: patient.address ?? '',
  });
  const [error, setError] = useState('');
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    setError('');
    const parsed = updatePatientIdentitySchema.safeParse({ ...form, age: Number(form.age), address: form.address.trim() || undefined });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the details.');
    try {
      await update.mutateAsync({ id: patient.id, input: parsed.data });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the changes.');
    }
  };

  return (
    <div className="patient-form edit-identity">
      <div className="form-row form-row--4">
        <label>
          IP Number (fixed)
          <input value={patient.ipNumber} disabled readOnly />
        </label>
        <label>
          Name (fixed)
          <input value={patient.fullName} disabled readOnly />
        </label>
        <label>
          Age
          <input type="number" min={0} max={150} value={form.age} onChange={set('age')} />
        </label>
        <label>
          Gender (fixed)
          <input value={patient.gender} disabled readOnly />
        </label>
        <label>
          Mobile
          <input inputMode="numeric" maxLength={10} value={form.mobile} onChange={set('mobile')} />
        </label>
        <label>
          Emergency Contact
          <input inputMode="numeric" maxLength={10} value={form.emergencyContact} onChange={set('emergencyContact')} />
        </label>
        <label>
          Aadhar
          <input inputMode="numeric" maxLength={12} value={form.aadhar} onChange={set('aadhar')} />
        </label>
        <label>
          Address
          <input maxLength={500} value={form.address} onChange={set('address')} />
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onDone} disabled={update.isPending}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
