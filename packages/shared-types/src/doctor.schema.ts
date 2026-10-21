import { z } from 'zod';

export const createDoctorSchema = z.object({
  name: z.string().min(1, 'Doctor name is required'),
  qualification: z.string().min(1, 'Qualification is required'),
  specialty: z.string().min(1, 'Specialty is required'),
});
export type CreateDoctorInput = z.infer<typeof createDoctorSchema>;

export const updateDoctorSchema = z.object({
  name: z.string().min(1, 'Doctor name is required'),
  qualification: z.string().min(1, 'Qualification is required'),
  specialty: z.string().min(1, 'Specialty is required'),
});
export type UpdateDoctorInput = z.infer<typeof updateDoctorSchema>;

// userId/loginId are nullable and isActive defaults true for a temporary,
// machine-created doctor reference (emergency bedside case, no login
// account — see docs/sync-contract.md) until admin promotes it into a real
// account. isTemporary is the discriminator the UI badges on.
export const doctorSummarySchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  loginId: z.string().nullable(),
  name: z.string(),
  qualification: z.string().nullable(),
  specialty: z.string().nullable(),
  isActive: z.boolean(),
  isTemporary: z.boolean(),
});
export type DoctorSummary = z.infer<typeof doctorSummarySchema>;

export const createDoctorResultSchema = z.object({
  doctor: doctorSummarySchema,
  loginId: z.string(),
  tempPassword: z.string(),
});
export type CreateDoctorResult = z.infer<typeof createDoctorResultSchema>;

export const resetDoctorPasswordResultSchema = z.object({
  loginId: z.string(),
  tempPassword: z.string(),
});
export type ResetDoctorPasswordResult = z.infer<typeof resetDoctorPasswordResultSchema>;
