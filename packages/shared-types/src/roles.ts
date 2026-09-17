export const ROLES = ['admin', 'doctor', 'reception', 'pharmacy', 'insurance'] as const;
export type Role = (typeof ROLES)[number];

/**
 * The permission matrix from the approved plan's "Strict Role-Based Access &
 * Workflow Enforcement" section. This is policy data, not just documentation —
 * the NestJS RolesGuard and any admin-facing "what can this role do" UI should
 * both read from this single source rather than re-encoding it.
 */
export const ROLE_CAPABILITIES: Record<Role, readonly string[]> = {
  admin: [
    'users:manage:any',
    'machines:credentials:rotate',
    'racks:manage',
    'fleet:view:all',
    'overrides:perform', // always named, reason-required, audited
  ],
  doctor: [
    'patients:vitals:write',
    'patients:diagnosis:write',
    'patients:machine:tag',
    'infusion-orders:author',
    'medicines:suggest',
    'medicines:request',
  ],
  reception: ['patients:register', 'patients:readmit', 'patients:discharge', 'patients:machine:tag'],
  pharmacy: [
    'inventory:manage',
    'medicines:catalog:manage',
    'infusion-orders:verify',
    'medicine-requests:fulfill',
  ],
  insurance: ['claims:decide', 'claims:revoke'],
} as const;
