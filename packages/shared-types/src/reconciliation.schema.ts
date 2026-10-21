import { z } from 'zod';

/**
 * One shared review queue for both patient dedup (a bedside-created patient
 * that turns out to already exist from reception) and medicine matching (a
 * bedside-configured step referencing a medicine name not yet in the
 * catalog) — never auto-merged, never blocking the machine. See the M7
 * section of the plan for the full reasoning.
 */
export const RECONCILIATION_KINDS = ['patient_duplicate', 'medicine_match'] as const;
export type ReconciliationKind = (typeof RECONCILIATION_KINDS)[number];

export const RECONCILIATION_STATUSES = ['pending', 'resolved'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const reconciliationCandidateSchema = z.object({
  id: z.string(),
  label: z.string(),
  score: z.number().min(0).max(1),
});
export type ReconciliationCandidate = z.infer<typeof reconciliationCandidateSchema>;

export const resolveReconciliationItemSchema = z.object({
  resolution: z.string().min(3, 'A resolution note is required'),
  // For a medicine_match item, linking to a real catalog entry; otherwise
  // omitted (a patient_duplicate resolution is review/documentation only in
  // v1 — no merge tooling, see the plan's deferred items).
  linkedMedicineId: z.string().uuid().optional(),
});
export type ResolveReconciliationItemInput = z.infer<typeof resolveReconciliationItemSchema>;
