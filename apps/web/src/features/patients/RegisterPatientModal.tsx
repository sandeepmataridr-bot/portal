import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { registerPatientSchema, type RegisterPatientInput } from '@infusion/shared-types';
import { Modal } from '../../components/Modal';
import { useActiveDoctors } from '../doctors/api';
import { OUT_PATIENT, useRooms } from '../rooms/api';
import { useInsuranceCompanies } from '../insurance/api';
import { useRegisterPatient } from './api';

const numOrUndef = (v: string) => (v === '' ? undefined : Number(v));

export function RegisterPatientModal({ onClose }: { onClose: () => void }) {
  const { data: doctors } = useActiveDoctors();
  const { data: rooms } = useRooms();
  const { data: companies } = useInsuranceCompanies();
  const registerPatient = useRegisterPatient();

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<RegisterPatientInput>({
    resolver: zodResolver(registerPatientSchema),
    defaultValues: {
      conditions: {
        insured: false,
        diabetic: false,
        hypertensive: false,
        cva: false,
        cad: false,
        seizures: false,
        thyroid: false,
      },
    },
  });

  const insured = watch('conditions.insured');
  const diabetic = watch('conditions.diabetic');
  const hypertensive = watch('conditions.hypertensive');

  // The server assigns the IP number; show it before closing.
  const [created, setCreated] = useState<{ ipNumber: string; fullName: string } | null>(null);
  const onSubmit = async (data: RegisterPatientInput) => {
    const patient = await registerPatient.mutateAsync(data);
    setCreated({ ipNumber: patient.ipNumber, fullName: patient.fullName });
  };

  if (created) {
    return (
      <Modal title="Patient registered" onClose={onClose}>
        <p className="registered-ip">
          ✅ <b>{created.fullName}</b> is registered with IP number <b>{created.ipNumber}</b>.
        </p>
        <div className="modal-footer">
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Register New Patient" onClose={onClose} wide>
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="patient-form">
        <h4 className="form-section-title">👤 Patient Identity</h4>
        <div className="form-row form-row--4">
          <label>
            IP Number
            <input type="text" value="Assigned automatically" disabled readOnly />
          </label>
          <label>
            Full Name *
            <input type="text" placeholder="Patient's full name" {...register('fullName')} />
            {errors.fullName && <span className="field-error">{errors.fullName.message}</span>}
          </label>
          <label>
            Age *
            <input type="number" min={0} max={150} {...register('age', { valueAsNumber: true })} />
            {errors.age && <span className="field-error">{errors.age.message}</span>}
          </label>
          <label>
            Gender *
            <select {...register('gender')}>
              <option value="">-- Select --</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
              <option value="Other">Other</option>
            </select>
            {errors.gender && <span className="field-error">{errors.gender.message}</span>}
          </label>
        </div>
        <div className="form-row form-row--4">
          <label>
            Mobile *
            <input type="text" maxLength={10} placeholder="10-digit number" {...register('mobile')} />
            {errors.mobile && <span className="field-error">{errors.mobile.message}</span>}
          </label>
          <label>
            Emergency Contact *
            <input type="text" maxLength={10} placeholder="10-digit number" {...register('emergencyContact')} />
            {errors.emergencyContact && <span className="field-error">{errors.emergencyContact.message}</span>}
          </label>
          <label>
            Aadhar *
            <input type="text" maxLength={12} placeholder="12-digit number" {...register('aadhar')} />
            {errors.aadhar && <span className="field-error">{errors.aadhar.message}</span>}
          </label>
          <label>
            Address
            <input type="text" placeholder="Patient's address" {...register('address')} />
          </label>
        </div>

        <h4 className="form-section-title">🩺 Vitals &amp; Clinical</h4>
        <div className="form-row form-row--4">
          <label>
            Weight (kg)
            <input type="text" inputMode="numeric" placeholder="0-500" {...register('weightKg', { setValueAs: numOrUndef })} />
          </label>
          <label>
            Height (cm)
            <input type="text" inputMode="numeric" placeholder="0-300" {...register('heightCm', { setValueAs: numOrUndef })} />
          </label>
          <label>
            BP Systolic
            <input type="text" inputMode="numeric" placeholder="mmHg" {...register('bpSystolic', { setValueAs: numOrUndef })} />
          </label>
          <label>
            BP Diastolic
            <input type="text" inputMode="numeric" placeholder="mmHg" {...register('bpDiastolic', { setValueAs: numOrUndef })} />
          </label>
        </div>
        <div className="form-row form-row--4">
          <label>
            Heart Rate (bpm)
            <input type="text" inputMode="numeric" placeholder="bpm" {...register('heartRate', { setValueAs: numOrUndef })} />
          </label>
          <label>
            Temperature (°F)
            <input type="text" inputMode="numeric" placeholder="°F" {...register('temperatureF', { setValueAs: numOrUndef })} />
          </label>
          <label>
            Diagnosis / Chief Complaint
            <input type="text" maxLength={200} placeholder="Reason for admission" {...register('diagnosis')} />
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
              <option value="">{OUT_PATIENT}</option>
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
        <div className="form-row form-row--4">
          <label>
            Others
            <input type="text" maxLength={15} placeholder="Specify (max 15 chars)" {...register('conditions.othersText')} />
          </label>
          {diabetic && (
            <label>
              Diabetic since (years)
              <input type="text" inputMode="numeric" {...register('conditions.diabeticYears', { setValueAs: numOrUndef })} />
              {errors.conditions?.diabeticYears && <span className="field-error">{errors.conditions.diabeticYears.message}</span>}
            </label>
          )}
          {hypertensive && (
            <label>
              Hypertensive since (years)
              <input type="text" inputMode="numeric" {...register('conditions.hypertensiveYears', { setValueAs: numOrUndef })} />
              {errors.conditions?.hypertensiveYears && (
                <span className="field-error">{errors.conditions.hypertensiveYears.message}</span>
              )}
            </label>
          )}
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
                Insurance Type
                <input type="text" placeholder="e.g. Group, Individual" {...register('insurance.insuranceType')} />
              </label>
              <label>
                Policy Number
                <input type="text" {...register('insurance.policyNumber')} />
              </label>
              <label>
                Member ID
                <input type="text" {...register('insurance.memberId')} />
              </label>
            </div>
            <div className="form-row form-row--4">
              <label>
                Relationship
                <input type="text" placeholder="Self, Spouse, Child..." {...register('insurance.relationship')} />
              </label>
              <label>
                Policy Start Date
                <input type="date" {...register('insurance.policyStart')} />
              </label>
              <label>
                Policy End Date
                <input type="date" {...register('insurance.policyEnd')} />
              </label>
              <label>
                TPA Name
                <input type="text" {...register('insurance.tpaName')} />
              </label>
            </div>
          </>
        )}

        {registerPatient.isError && <p className="form-error">❌ {(registerPatient.error as Error).message}</p>}

        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={isSubmitting}>
            {isSubmitting ? 'Saving…' : '✅ Register Patient'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
