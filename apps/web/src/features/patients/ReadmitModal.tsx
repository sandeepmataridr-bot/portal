import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { readmitPatientSchema, type ReadmitPatientInput } from '@infusion/shared-types';
import { Modal } from '../../components/Modal';
import { useActiveDoctors } from '../doctors/api';
import { useRooms } from '../rooms/api';
import { useInsuranceCompanies } from '../insurance/api';
import { usePatient, useReadmitPatient } from './api';

const numOrUndef = (v: string) => (v === '' ? undefined : Number(v));

export function ReadmitModal({ patientId, onClose }: { patientId: string; onClose: () => void }) {
  const { data: patient } = usePatient(patientId);
  const { data: doctors } = useActiveDoctors();
  const { data: rooms } = useRooms();
  const { data: companies } = useInsuranceCompanies();
  const readmit = useReadmitPatient();

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ReadmitPatientInput>({
    resolver: zodResolver(readmitPatientSchema),
    values: patient
      ? {
          doctorId: patient.doctor?.id ?? '',
          address: patient.address ?? undefined,
          weightKg: patient.weightKg ?? undefined,
          heightCm: patient.heightCm ?? undefined,
          bpSystolic: patient.bpSystolic ?? undefined,
          bpDiastolic: patient.bpDiastolic ?? undefined,
          heartRate: patient.heartRate ?? undefined,
          temperatureF: patient.temperatureF ?? undefined,
          diagnosis: patient.diagnosis ?? undefined,
          conditions: {
            insured: patient.insured,
            diabetic: patient.diabetic,
            diabeticYears: patient.diabeticYears ?? undefined,
            hypertensive: patient.hypertensive,
            hypertensiveYears: patient.hypertensiveYears ?? undefined,
            cva: patient.cva,
            cad: patient.cad,
            seizures: patient.seizures,
            thyroid: patient.thyroid,
            othersText: patient.othersText ?? undefined,
          },
        }
      : undefined,
  });

  const insured = watch('conditions.insured');

  const onSubmit = async (data: ReadmitPatientInput) => {
    await readmit.mutateAsync({ id: patientId, input: data });
    onClose();
  };

  if (!patient) return null;

  return (
    <Modal title="Update Patient Details (Readmit)" onClose={onClose} wide>
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="patient-form">
        <div className="frozen-field-notice">
          IP {patient.ipNumber} · {patient.fullName} · Age {patient.age} · {patient.gender} (identity fields are frozen on readmit)
        </div>

        <h4 className="form-section-title">🩺 Vitals &amp; Clinical</h4>
        <div className="form-row form-row--4">
          <label>
            Weight (kg)
            <input type="text" inputMode="numeric" {...register('weightKg', { setValueAs: numOrUndef })} />
          </label>
          <label>
            Height (cm)
            <input type="text" inputMode="numeric" {...register('heightCm', { setValueAs: numOrUndef })} />
          </label>
          <label>
            BP Systolic
            <input type="text" inputMode="numeric" {...register('bpSystolic', { setValueAs: numOrUndef })} />
          </label>
          <label>
            BP Diastolic
            <input type="text" inputMode="numeric" {...register('bpDiastolic', { setValueAs: numOrUndef })} />
          </label>
        </div>
        <div className="form-row form-row--4">
          <label>
            Heart Rate (bpm)
            <input type="text" inputMode="numeric" {...register('heartRate', { setValueAs: numOrUndef })} />
          </label>
          <label>
            Temperature (°F)
            <input type="text" inputMode="numeric" {...register('temperatureF', { setValueAs: numOrUndef })} />
          </label>
          <label>
            Diagnosis
            <input type="text" maxLength={200} {...register('diagnosis')} />
          </label>
          <label>
            Attending Doctor *
            <select {...register('doctorId')}>
              <option value="">-- Select --</option>
              {doctors?.map((d) => (
                <option key={d.id} value={d.id}>
                  Dr. {d.name}
                </option>
              ))}
            </select>
            {errors.doctorId && <span className="field-error">{errors.doctorId.message}</span>}
          </label>
          <label>
            Room
            <select {...register('roomId', { setValueAs: (v: string) => v || undefined })}>
              <option value="">Keep current room</option>
              {rooms?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            {errors.roomId && <span className="field-error">{errors.roomId.message}</span>}
          </label>
        </div>

        <h4 className="form-section-title">📋 Medical History &amp; Conditions</h4>
        <div className="condition-grid">
          <label className="condition-pill">
            <input type="checkbox" {...register('conditions.insured')} /> 🛡️ Insured
          </label>
          <label className="condition-pill">
            <input type="checkbox" {...register('conditions.diabetic')} /> 🩸 Diabetic
          </label>
          <label className="condition-pill">
            <input type="checkbox" {...register('conditions.hypertensive')} /> 💓 Hypertensive
          </label>
          <label className="condition-pill">
            <input type="checkbox" {...register('conditions.cva')} /> 🧠 CVA
          </label>
          <label className="condition-pill">
            <input type="checkbox" {...register('conditions.cad')} /> ❤️ CAD
          </label>
          <label className="condition-pill">
            <input type="checkbox" {...register('conditions.seizures')} /> ⚡ Seizures
          </label>
          <label className="condition-pill">
            <input type="checkbox" {...register('conditions.thyroid')} /> 🦋 Thyroid
          </label>
        </div>

        {insured && (
          <>
            <h4 className="form-section-title">🛡️ Insurance Details</h4>
            <div className="form-row form-row--4">
              <label>
                Insurance Company
                <select {...register('insurance.insuranceCompanyId')}>
                  <option value="">-- Select --</option>
                  {companies?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Policy Number
                <input type="text" {...register('insurance.policyNumber')} />
              </label>
              <label>
                Member ID
                <input type="text" {...register('insurance.memberId')} />
              </label>
              <label>
                TPA Name
                <input type="text" {...register('insurance.tpaName')} />
              </label>
            </div>
          </>
        )}

        {readmit.isError && <p className="form-error">❌ {(readmit.error as Error).message}</p>}

        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={isSubmitting}>
            {isSubmitting ? 'Saving…' : 'Update Details'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
