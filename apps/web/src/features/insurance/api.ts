import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClaimDecisionInput, ClaimRevokeInput } from '@infusion/shared-types';
import { apiFetch } from '../../lib/api';

export interface InsuranceCompany {
  id: string;
  name: string;
}

export interface InsuranceClaim {
  id: string;
  patientId: string;
  patient: { fullName: string; ipNumber: string; diagnosis: string | null; createdAt: string };
  insuranceCompany: { name: string } | null;
  policyNumber: string | null;
  status: string;
  remarks: string | null;
  approvedById: string | null;
}

export interface RejectionReason {
  code: string;
  description: string;
}

export function useInsuranceCompanies() {
  return useQuery({
    queryKey: ['insurance', 'companies'],
    queryFn: () => apiFetch<InsuranceCompany[]>('/insurance/companies'),
  });
}

export function useRejectionReasons() {
  return useQuery({
    queryKey: ['insurance', 'rejection-reasons'],
    queryFn: () => apiFetch<RejectionReason[]>('/insurance/rejection-reasons'),
  });
}

export function useClaims(status: string, search: string) {
  return useQuery({
    queryKey: ['insurance', 'claims', status, search],
    queryFn: () =>
      apiFetch<InsuranceClaim[]>(`/insurance/claims?${new URLSearchParams({ ...(status ? { status } : {}), ...(search ? { search } : {}) })}`),
  });
}

export function useClaimDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ClaimDecisionInput }) =>
      apiFetch(`/insurance/claims/${id}/decision`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['insurance', 'claims'] }),
  });
}

export function useClaimRevoke() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ClaimRevokeInput }) =>
      apiFetch(`/insurance/claims/${id}/revoke`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['insurance', 'claims'] }),
  });
}
