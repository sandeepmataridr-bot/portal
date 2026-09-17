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

export const doctorSummarySchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  loginId: z.string(),
  name: z.string(),
  qualification: z.string().nullable(),
  specialty: z.string().nullable(),
  isActive: z.boolean(),
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
