import { z } from 'zod';

export const medicineStatusSchema = z.enum(['ACTIVE', 'INACTIVE']);

// Fields carried over from the reference `medicines` table
// (database/pharmacy_schema.sql) plus the new cap fields that table never had.
export const medicineSchema = z.object({
  id: z.string().uuid(),
  medicineCode: z.string().min(1),
  name: z.string().min(1),
  genericName: z.string().optional(),
  brand: z.string().optional(),
  category: z.string().optional(),
  concentration: z.string().min(1),
  manufacturer: z.string().optional(),
  unitMl: z.number().positive(),
  stockQty: z.number().nonnegative(),
  minStock: z.number().nonnegative().default(0),
  reorderLevel: z.number().nonnegative().default(0),
  pricePerUnit: z.number().nonnegative(),
  batchNo: z.string().optional(),
  expiryDate: z.string().date().optional(),
  rackNo: z.number().int().positive().optional(),
  channelNo: z.number().int().positive().optional(),
  flushRequired: z.boolean().default(false),
  flushVolumeMl: z.number().nonnegative().default(0),
  highAlert: z.boolean().default(false),
  status: medicineStatusSchema.default('ACTIVE'),

  // New — not present in the reference schema. `highAlert` was stored there
  // but never actually enforced anywhere; these fields plus the cap-checking
  // logic below are what make it real.
  maxFlowRateMlPerH: z.number().positive().nullable(),
  maxSingleDoseMl: z.number().positive().nullable(),
  /** Non-overridable physiological/device ceiling. Distinct from the clinically-configurable soft cap above. */
  absoluteMaxFlowRateMlPerH: z.number().positive().nullable(),
});
export type Medicine = z.infer<typeof medicineSchema>;

export const upsertMedicineSchema = medicineSchema.omit({ id: true });
export type UpsertMedicineInput = z.infer<typeof upsertMedicineSchema>;

export const STOCK_IN_SUPPLIERS = ['Self', 'Sample Pack', 'Specimen Product', 'Supplier A', 'Supplier B', 'Other'] as const;

export const stockInSchema = z.object({
  medicineId: z.string().uuid(),
  quantity: z.number().positive(),
  unitCost: z.number().nonnegative(),
  supplier: z.enum(STOCK_IN_SUPPLIERS),
  invoiceNo: z.string().max(100).optional(),
  remarks: z.string().max(1000).optional(),
});
export type StockInInput = z.infer<typeof stockInSchema>;

export const PAYMENT_METHODS = ['Cash', 'UPI/Card/Netbanking', 'Insurance'] as const;

export const stockOutSchema = z
  .object({
    medicineId: z.string().uuid(),
    quantity: z.number().positive(),
    isDamaged: z.boolean().default(false),
    patientId: z.string().uuid().optional(),
    machineId: z.string().uuid().optional(),
    paymentMethod: z.enum(PAYMENT_METHODS).optional(),
    transactionRef: z.string().max(100).optional(),
    remarks: z.string().max(1000).optional(),
  })
  .refine((d) => d.isDamaged || !!d.patientId, {
    message: 'A patient (or Damaged/Expiry) must be selected',
    path: ['patientId'],
  })
  .refine((d) => d.isDamaged || !!d.paymentMethod, {
    message: 'Payment method is required unless Damaged/Expiry',
    path: ['paymentMethod'],
  })
  .refine((d) => d.paymentMethod !== 'UPI/Card/Netbanking' || !!d.transactionRef, {
    message: 'Transaction ID is required for digital payments',
    path: ['transactionRef'],
  });
export type StockOutInput = z.infer<typeof stockOutSchema>;

export const createMedicineRequestSchema = z.object({
  patientId: z.string().uuid(),
  medicineName: z.string().min(1, 'Medicine name is required'),
  notes: z.string().max(1000).optional(),
});
export type CreateMedicineRequestInput = z.infer<typeof createMedicineRequestSchema>;

export const MEDICINE_REQUEST_STATUSES = ['pending', 'fulfilled', 'rejected'] as const;
export const updateMedicineRequestStatusSchema = z.object({
  status: z.enum(['fulfilled', 'rejected']),
});
export type UpdateMedicineRequestStatusInput = z.infer<typeof updateMedicineRequestStatusSchema>;
