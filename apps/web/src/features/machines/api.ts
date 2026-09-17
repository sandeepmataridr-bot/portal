import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateMachineInput, FleetStatus, MachineSummary } from '@infusion/shared-types';
import { apiFetch } from '../../lib/api';

export function useMachines() {
  return useQuery({
    queryKey: ['machines'],
    queryFn: () => apiFetch<MachineSummary[]>('/machines'),
  });
}

export function useFleetStatus() {
  return useQuery({
    queryKey: ['machines', 'fleet-status'],
    queryFn: () => apiFetch<FleetStatus>('/machines/fleet-status'),
    refetchInterval: 15_000,
  });
}

export function useCreateMachine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMachineInput) => apiFetch<MachineSummary>('/machines', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['machines'] });
    },
  });
}

export function useIssueMachineCredential() {
  return useMutation({
    mutationFn: (machineId: string) =>
      apiFetch<{ machineId: string; machineCode: string; token: string }>(`/sync/machines/${machineId}/credentials`, { method: 'POST' }),
  });
}
