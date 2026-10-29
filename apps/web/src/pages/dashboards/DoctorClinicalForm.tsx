import { useState } from 'react';
import type { PatientDetail } from '../../features/patients/api';
import { useUpdatePatientClinical } from '../../features/patients/api';

const numOrUndef = (v: string) => (v === '' ? undefined : Number(v));

export function DoctorClinicalForm({ patient }: { patient: PatientDetail }) {
  const updateClinical = useUpdatePatientClinical();
  const [form, setForm] = useState({
    address: patient.address ?? '',
    weightKg: patient.weightKg?.toString() ?? '',
    heightCm: patient.heightCm?.toString() ?? '',
    bpSystolic: patient.bpSystolic?.toString() ?? '',
    bpDiastolic: patient.bpDiastolic?.toString() ?? '',
    heartRate: patient.heartRate?.toString() ?? '',
    temperatureF: patient.temperatureF?.toString() ?? '',
    diabetic: patient.diabetic,
    diabeticYears: patient.diabeticYears?.toString() ?? '',
    hypertensive: patient.hypertensive,
    hypertensiveYears: patient.hypertensiveYears?.toString() ?? '',
    cva: patient.cva,
    cad: patient.cad,
    seizures: patient.seizures,
    thyroid: patient.thyroid,
    othersText: patient.othersText ?? '',
  });
  // The parent keys this form by patient.id, so all of it starts again for each patient.
  const [diagnosis, setDiagnosis] = useState(patient.diagnosis ?? '');
  const [doctorNotes, setDoctorNotes] = useState('');

  const saveDetails = async () => {
    await updateClinical.mutateAsync({
      id: patient.id,
      input: {
        address: form.address || undefined,
        weightKg: numOrUndef(form.weightKg),
        heightCm: numOrUndef(form.heightCm),
        bpSystolic: numOrUndef(form.bpSystolic),
        bpDiastolic: numOrUndef(form.bpDiastolic),
        heartRate: numOrUndef(form.heartRate),
        temperatureF: numOrUndef(form.temperatureF),
        conditions: {
          diabetic: form.diabetic,
          diabeticYears: numOrUndef(form.diabeticYears),
          hypertensive: form.hypertensive,
          hypertensiveYears: numOrUndef(form.hypertensiveYears),
          cva: form.cva,
          cad: form.cad,
          seizures: form.seizures,
          thyroid: form.thyroid,
          othersText: form.othersText || undefined,
        },
      },
    });
  };

  const saveSummary = async () => {
    await updateClinical.mutateAsync({
      id: patient.id,
      input: { diagnosis: diagnosis || undefined, doctorNotes: doctorNotes || undefined },
    });
  };

  return (
    <div className="info-card">
      <h4 className="form-section-title">📋 Patient Details</h4>
      <div className="form-row form-row--4 patient-form">
        <label>
          Full Name *<input type="text" value={patient.fullName} readOnly />
        </label>
        <label>
          Age *<input type="text" value={patient.age} readOnly />
        </label>
        <label>
          IP Number *<input type="text" value={patient.ipNumber} readOnly />
        </label>
        <label>
          Address
          <input type="text" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </label>
      </div>
      <div className="form-row form-row--4 patient-form">
        <label>
          Weight (kg)
          <input type="text" inputMode="numeric" value={form.weightKg} onChange={(e) => setForm({ ...form, weightKg: e.target.value })} />
        </label>
        <label>
          Height (cm)
          <input type="text" inputMode="numeric" value={form.heightCm} onChange={(e) => setForm({ ...form, heightCm: e.target.value })} />
        </label>
        <label>
          BP Systolic
          <input type="text" inputMode="numeric" value={form.bpSystolic} onChange={(e) => setForm({ ...form, bpSystolic: e.target.value })} />
        </label>
        <label>
          BP Diastolic
          <input type="text" inputMode="numeric" value={form.bpDiastolic} onChange={(e) => setForm({ ...form, bpDiastolic: e.target.value })} />
        </label>
      </div>
      <div className="condition-grid">
        <label className="condition-pill">
          <input type="checkbox" checked={form.diabetic} onChange={(e) => setForm({ ...form, diabetic: e.target.checked })} /> Diabetic
        </label>
        <label className="condition-pill">
          <input type="checkbox" checked={form.hypertensive} onChange={(e) => setForm({ ...form, hypertensive: e.target.checked })} /> Hypertensive
        </label>
        <label className="condition-pill">
          <input type="checkbox" checked={form.cva} onChange={(e) => setForm({ ...form, cva: e.target.checked })} /> CVA
        </label>
        <label className="condition-pill">
          <input type="checkbox" checked={form.cad} onChange={(e) => setForm({ ...form, cad: e.target.checked })} /> CAD
        </label>
        <label className="condition-pill">
          <input type="checkbox" checked={form.seizures} onChange={(e) => setForm({ ...form, seizures: e.target.checked })} /> Seizures
        </label>
        <label className="condition-pill">
          <input type="checkbox" checked={form.thyroid} onChange={(e) => setForm({ ...form, thyroid: e.target.checked })} /> Thyroid
        </label>
      </div>
      <button type="button" className="btn-primary" onClick={saveDetails} disabled={updateClinical.isPending}>
        💾 Save Changes
      </button>

      <h4 className="form-section-title">📋 Doctor Summary</h4>
      <div className="patient-form">
        <label>
          Diagnosis
          <input type="text" maxLength={200} value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} />
        </label>
        <label>
          Clinical Notes
          <textarea rows={2} value={doctorNotes} onChange={(e) => setDoctorNotes(e.target.value)} placeholder="Add clinical notes, remarks..." />
        </label>
        <button type="button" className="btn-primary" onClick={saveSummary} disabled={updateClinical.isPending}>
          💾 Save Summary
        </button>
      </div>
    </div>
  );
}
