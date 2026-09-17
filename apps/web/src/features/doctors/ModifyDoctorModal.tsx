import { useState } from 'react';
import type { DoctorSummary } from '@infusion/shared-types';
import { Modal } from '../../components/Modal';
import { useUpdateDoctor } from './api';

export function ModifyDoctorModal({ doctor, onClose }: { doctor: DoctorSummary; onClose: () => void }) {
  const [name, setName] = useState(doctor.name);
  const [qualification, setQualification] = useState(doctor.qualification ?? '');
  const [specialty, setSpecialty] = useState(doctor.specialty ?? '');
  const update = useUpdateDoctor();
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await update.mutateAsync({ id: doctor.id, input: { name, qualification, specialty } });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title="✏️ Modify Doctor" onClose={onClose}>
      <div className="patient-form">
        <label>
          Doctor Name *<input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Qualification *<input value={qualification} onChange={(e) => setQualification(e.target.value)} placeholder="e.g. MBBS, MD" />
        </label>
        <label>
          Specialization *<input value={specialty} onChange={(e) => setSpecialty(e.target.value)} placeholder="e.g. Cardiology" />
        </label>
        {error && <p className="form-error">❌ {error}</p>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={submit} disabled={update.isPending}>
          💾 Save Changes
        </button>
      </div>
    </Modal>
  );
}
