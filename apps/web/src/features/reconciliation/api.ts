import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ResolveReconciliationItemInput } from '@infusion/shared-types';
import { apiFetch } from '../../lib/api';

export interface ReconciliationCandidate {
  id: string;
  label: string;
  score: number;
}

export interface ReconciliationItem {
  id: string;
  kind: 'patient_duplicate' | 'medicine_match';
  status: 'pending' | 'resolved';
  machineId: string;
  machine: { machineCode: string };
  entityType: string;
  entityId: string;
  rawPayload: Record<string, unknown>;
  candidates: ReconciliationCandidate[] | null;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export function useReconciliationQueue(status = 'pending') {
  return useQuery({
    queryKey: ['reconciliation-items', status],
    queryFn: () => apiFetch<ReconciliationItem[]>(`/reconciliation-items?${new URLSearchParams({ status })}`),
    refetchInterval: 20_000,
  });
}

export function useResolveReconciliationItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ResolveReconciliationItemInput }) =>
      apiFetch(`/reconciliation-items/${id}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reconciliation-items'] });
    },
  });
}
