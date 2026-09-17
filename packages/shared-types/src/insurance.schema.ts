import { z } from 'zod';

export const CLAIM_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'documents_required',
  'approved',
  'partially_approved',
  'rejected',
  'closed',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Statuses a decision can be made from (mirrors insurance.html's `canAct`). */
export const CLAIM_ACTIONABLE_STATUSES: readonly ClaimStatus[] = ['draft', 'submitted', 'under_review', 'documents_required'];
/** Statuses that can be revoked back to `under_review` (mirrors `canRevoke`). */
export const CLAIM_REVOCABLE_STATUSES: readonly ClaimStatus[] = ['partially_approved', 'rejected'];

export const CLAIM_DECISION_ACTIONS = ['Approve', 'Partially Approve', 'Reject', 'Request Documents'] as const;
export type ClaimDecisionAction = (typeof CLAIM_DECISION_ACTIONS)[number];

// The exact 20 rejection reason codes catalogued from the reference app's
// insurance.html reject modal (REJECTION_REASONS in the old app.py).
export const REJECTION_REASONS = [
  { code: 'R001', description: 'Policy Not Found' },
  { code: 'R002', description: 'Policy Expired' },
  { code: 'R003', description: 'Policy Inactive' },
  { code: 'R004', description: 'Premium Pending' },
  { code: 'R005', description: 'Treatment Not Covered' },
  { code: 'R006', description: 'Waiting Period Not Completed' },
  { code: 'R007', description: 'Sum Insured Exhausted' },
  { code: 'R008', description: 'Invalid Insurance ID' },
  { code: 'R009', description: 'Patient Details Mismatch' },
  { code: 'R010', description: 'Hospital Not in Network' },
  { code: 'R011', description: 'Missing Documents' },
  { code: 'R012', description: 'Duplicate Claim' },
  { code: 'R013', description: 'Claim Already Settled' },
  { code: 'R014', description: 'Prior Authorization Required' },
  { code: 'R015', description: 'Fraud Suspected' },
  { code: 'R016', description: 'Medical Necessity Not Established' },
  { code: 'R017', description: 'Invalid Diagnosis' },
  { code: 'R018', description: 'Invalid Procedure' },
  { code: 'R019', description: 'Coverage Limit Exceeded' },
  { code: 'R020', description: 'Other (Specify Remarks)' },
] as const;

export const claimDecisionSchema = z
  .object({
    action: z.enum(CLAIM_DECISION_ACTIONS),
    remarks: z.string().max(2000).optional(),
    reasonCode: z.string().optional(),
  })
  .refine((d) => d.action !== 'Reject' || !!d.reasonCode, {
    message: 'A rejection reason is required',
    path: ['reasonCode'],
  })
  .refine((d) => d.reasonCode !== 'R020' || !!d.remarks, {
    message: 'Please specify the reason when using "Other"',
    path: ['remarks'],
  });
export type ClaimDecisionInput = z.infer<typeof claimDecisionSchema>;

export const claimRevokeSchema = z.object({
  remarks: z.string().max(2000).optional(),
});
export type ClaimRevokeInput = z.infer<typeof claimRevokeSchema>;
