import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateMachineInput, FleetStatus, MachineCommandSummary, MachineSummary, SendMachineCommandInput } from '@infusion/shared-types';
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

// Polls rather than relying solely on the WS push (§5's realtime client
// invalidates this same key on `machine_command.updated`) — a command's
// status can also change via the machine's own follow-up push, so this stays
// a belt-and-suspenders poll like every other live query in this app.
export function useMachineCommands(machineId: string | null) {
  return useQuery({
    queryKey: ['machine-commands', machineId],
    queryFn: () => apiFetch<MachineCommandSummary[]>(`/machines/${machineId}/commands`),
    enabled: !!machineId,
    refetchInterval: 5000,
  });
}

export function useSendMachineCommand(machineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SendMachineCommandInput) =>
      apiFetch<MachineCommandSummary>(`/machines/${machineId}/commands`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['machine-commands', machineId] });
    },
  });
}
