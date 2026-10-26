import { z } from 'zod';

// Field shapes mirror the reference app's registration form exactly
// (reception.html / home.html "Register New Patient" modal) so the same
// validation rules apply client- and server-side.
export const patientIdentitySchema = z.object({
  ipNumber: z.string().regex(/^\d{1,6}$/, 'IP Number must be up to 6 digits'),
  fullName: z.string().min(1, "Patient's full name is required"),
  age: z.number().int().min(0).max(150),
  gender: z.enum(['Male', 'Female', 'Other']),
  mobile: z.string().regex(/^[6-9]\d{9}$/, 'Mobile must be a 10-digit number starting with 6-9'),
  emergencyContact: z.string().regex(/^\d{10}$/, 'Emergency contact must be a 10-digit number'),
  aadhar: z.string().regex(/^\d{12}$/, 'Aadhar must be a 12-digit number'),
  address: z.string().max(500).optional(),
});

export const patientVitalsSchema = z.object({
  weightKg: z.number().min(0).max(500).optional(),
  heightCm: z.number().min(0).max(300).optional(),
  bpSystolic: z.number().min(0).max(300).optional(),
  bpDiastolic: z.number().min(0).max(300).optional(),
  heartRate: z.number().min(0).max(300).optional(),
  temperatureF: z.number().min(0).max(110).optional(),
  diagnosis: z.string().max(200).optional(),
  doctorId: z.string().uuid('Attending doctor is required'),
});

// Plain object shape (no refinements) so it can still be `.partial()`-ed for
// the doctor clinical-update endpoint below — refinements are applied
// separately on top where the full shape is required (register/readmit).
export const patientConditionsObjectSchema = z.object({
  insured: z.boolean().default(false),
  diabetic: z.boolean().default(false),
  diabeticYears: z.number().int().min(0).optional(),
  hypertensive: z.boolean().default(false),
  hypertensiveYears: z.number().int().min(0).optional(),
  cva: z.boolean().default(false),
  cad: z.boolean().default(false),
  seizures: z.boolean().default(false),
  thyroid: z.boolean().default(false),
  othersText: z.string().max(15).optional(),
});

export const patientConditionsSchema = patientConditionsObjectSchema
  .refine((c) => !c.diabetic || (c.diabeticYears != null && c.diabeticYears >= 0), {
    message: 'Diabetic since (years) is required when Diabetic is checked',
    path: ['diabeticYears'],
  })
  .refine((c) => !c.hypertensive || (c.hypertensiveYears != null && c.hypertensiveYears >= 0), {
    message: 'Hypertensive since (years) is required when Hypertensive is checked',
    path: ['hypertensiveYears'],
  });

export const patientInsuranceDetailsSchema = z.object({
  insuranceCompanyId: z.string().uuid().optional(),
  insuranceType: z.string().max(100).optional(),
  policyNumber: z.string().max(100).optional(),
  memberId: z.string().max(100).optional(),
  relationship: z.string().max(100).optional(),
  policyStart: z.string().date().optional(),
  policyEnd: z.string().date().optional(),
  tpaName: z.string().max(100).optional(),
});

export const registerPatientSchema = patientIdentitySchema
  .merge(patientVitalsSchema)
  .extend({
    conditions: patientConditionsSchema,
    insurance: patientInsuranceDetailsSchema.optional(),
  })
  .refine((data) => !data.conditions.insured || !!data.insurance, {
    message: 'Insurance details are required when the patient is marked insured',
    path: ['insurance'],
  });
export type RegisterPatientInput = z.infer<typeof registerPatientSchema>;

export const tagPatientMachineSchema = z.object({
  machineId: z.string().uuid(),
});
export type TagPatientMachineInput = z.infer<typeof tagPatientMachineSchema>;

// Readmitting a discharged patient — identity fields (IP/name/aadhar/etc.)
// are frozen and not part of this payload, matching the reception.html
// readmit modal's read-only identity section.
export const readmitPatientSchema = z.object({
  doctorId: z.string().uuid('Attending doctor is required'),
  address: z.string().max(500).optional(),
  weightKg: z.number().min(0).max(500).optional(),
  heightCm: z.number().min(0).max(300).optional(),
  bpSystolic: z.number().min(0).max(300).optional(),
  bpDiastolic: z.number().min(0).max(300).optional(),
  heartRate: z.number().min(0).max(300).optional(),
  temperatureF: z.number().min(0).max(110).optional(),
  diagnosis: z.string().max(200).optional(),
  conditions: patientConditionsSchema,
  insurance: patientInsuranceDetailsSchema.optional(),
});
export type ReadmitPatientInput = z.infer<typeof readmitPatientSchema>;

export const dischargePatientSchema = z.object({
  remarks: z.string().max(1000).optional(),
});
export type DischargePatientInput = z.infer<typeof dischargePatientSchema>;

/**
 * Reception (or admin) corrects a patient's identity details. IP number and
 * full name are fixed once registered and are never part of this payload.
 */
export const PATIENT_FIXED_FIELDS = ['ipNumber', 'fullName'] as const;
// Any subset of the editable fields; .strict() refuses ipNumber/fullName outright.
export const updatePatientIdentitySchema = patientIdentitySchema.omit({ ipNumber: true, fullName: true }).partial().strict();
export type UpdatePatientIdentityInput = z.infer<typeof updatePatientIdentitySchema>;

/**
 * Reception (or admin) moves a patient to another attending doctor. The
 * reason is recorded in the patient's history timeline (DOCTOR_REASSIGNED).
 */
export const DOCTOR_CHANGE_REASONS = ['wrong_doctor', 'doctor_unavailable', 'new_issue', 'other'] as const;
export type DoctorChangeReason = (typeof DOCTOR_CHANGE_REASONS)[number];
export const DOCTOR_CHANGE_REASON_LABEL: Record<DoctorChangeReason, string> = {
  wrong_doctor: 'Assigned to the wrong doctor',
  doctor_unavailable: 'Doctor unavailable',
  new_issue: 'Earlier issue resolved, new issue',
  other: 'Other',
};
export const changePatientDoctorSchema = z
  .object({
    doctorId: z.string().uuid('Choose the new doctor'),
    reason: z.enum(DOCTOR_CHANGE_REASONS),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.reason !== 'other' || !!v.note, { message: 'Say why the doctor is changing', path: ['note'] });
export type ChangePatientDoctorInput = z.infer<typeof changePatientDoctorSchema>;

// Doctor's own clinical edit (doctor.html "Patient Details" + "Doctor
// Summary" sections) — never reassigns the attending doctor, that's a
// reception/doctor machine-tagging-style action handled separately.
export const patientClinicalUpdateSchema = z.object({
  address: z.string().max(500).optional(),
  weightKg: z.number().min(0).max(500).optional(),
  heightCm: z.number().min(0).max(300).optional(),
  bpSystolic: z.number().min(0).max(300).optional(),
  bpDiastolic: z.number().min(0).max(300).optional(),
  heartRate: z.number().min(0).max(300).optional(),
  temperatureF: z.number().min(0).max(110).optional(),
  diagnosis: z.string().max(200).optional(),
  doctorNotes: z.string().max(2000).optional(),
  conditions: patientConditionsObjectSchema.partial().optional(),
});
export type PatientClinicalUpdateInput = z.infer<typeof patientClinicalUpdateSchema>;
