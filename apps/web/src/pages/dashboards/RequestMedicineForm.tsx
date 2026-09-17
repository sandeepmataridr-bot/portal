import { useState } from 'react';
import { useCreateMedicineRequest } from '../../features/medicine-requests/api';

export function RequestMedicineForm({ patientId }: { patientId: string }) {
  const [medicineName, setMedicineName] = useState('');
  const [notes, setNotes] = useState('');
  const createRequest = useCreateMedicineRequest();
  const [status, setStatus] = useState<string | null>(null);

  const submit = async () => {
    if (!medicineName.trim()) return;
    await createRequest.mutateAsync({ patientId, medicineName, notes: notes || undefined });
    setStatus(`✅ Request for "${medicineName}" sent to pharmacy.`);
    setMedicineName('');
    setNotes('');
  };

  return (
    <div className="info-card">
      <h4 className="form-section-title">📨 Request New Medicine</h4>
      <p className="form-hint">If the required medicine is not available in stock, request it here.</p>
      <div className="form-row form-row--4 patient-form">
        <label>
          Medicine Name *
          <input type="text" placeholder="Enter medicine name" value={medicineName} onChange={(e) => setMedicineName(e.target.value)} />
        </label>
        <label>
          Remarks (optional)
          <input type="text" placeholder="Any additional notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      <button type="button" className="btn-warning" onClick={submit} disabled={createRequest.isPending}>
        📨 Request Medicine
      </button>
      {status && <p>{status}</p>}
    </div>
  );
}
