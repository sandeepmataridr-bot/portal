import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateInfusionOrderInput } from '@infusion/shared-types';
import { apiFetch } from '../../lib/api';

export interface InfusionStep {
  id: string;
  orderId: string;
  stepNumber: number;
  medicineId: string;
  medicine: { id: string; name: string; concentration: string; highAlert: boolean };
  rackNo: number | null;
  channelNo: number | null;
  plannedVolumeMl: number;
  plannedRateMlPerH: number;
  status: string;
  pharmacyVerifiedById: string | null;
  highAlertConfirmedById: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface InfusionOrder {
  id: string;
  patientId: string;
  machineId: string;
  status: string;
  clinicalNotes: string | null;
  steps: InfusionStep[];
  createdAt: string;
}

export interface StepWithOrderPatient extends InfusionStep {
  order: InfusionOrder & { patient: { id: string; fullName: string; ipNumber: string } };
}

export function useStepsByStatus(status: string) {
  return useQuery({
    queryKey: ['infusion-steps', 'by-status', status],
    queryFn: () => apiFetch<StepWithOrderPatient[]>(`/infusion-steps?${new URLSearchParams({ status })}`),
    refetchInterval: 15_000,
  });
}

export interface LiveStatus {
  machineId: string;
  patientId: string;
  stepId: string | null;
  currentMedicineName: string | null;
  remainingVolumeMl: number;
  dispensedVolumeMl: number;
  flowRateMlPerH: number;
  infusedTimeMin: number;
  pumpState: 'RUNNING' | 'PAUSED' | 'STOPPED';
  // The machine screen's own free-text "Working Mode"/"Working Status" and
  // pause timer (InfusionLiveStatus in schema.prisma), shown by MachineMirrorView.
  workingMode?: string | null;
  workingStatusRaw?: string | null;
  pauseTimeSec?: number | null;
  lastUpdateAt: string;
}

export function usePatientOrders(patientId: string | null) {
  return useQuery({
    queryKey: ['infusion-orders', 'patient', patientId],
    queryFn: () => apiFetch<InfusionOrder[]>(`/patients/${patientId}/infusion-orders`),
    enabled: !!patientId,
  });
}

export function useLiveStatus(machineId: string | null) {
  return useQuery({
    queryKey: ['live-status', machineId],
    queryFn: () => apiFetch<LiveStatus | null>(`/machines/${machineId}/live-status`),
    enabled: !!machineId,
    refetchInterval: 5000,
  });
}

function useOrderMutations() {
  const queryClient = useQueryClient();
  const invalidate = (patientId: string) => {
    queryClient.invalidateQueries({ queryKey: ['infusion-orders', 'patient', patientId] });
    queryClient.invalidateQueries({ queryKey: ['live-status'] });
    queryClient.invalidateQueries({ queryKey: ['infusion-steps', 'by-status'] });
  };
  return { queryClient, invalidate };
}

export function useCreateInfusionOrder() {
  const { invalidate } = useOrderMutations();
  return useMutation({
    mutationFn: (input: CreateInfusionOrderInput) =>
      apiFetch<InfusionOrder>('/infusion-orders', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: (order) => invalidate(order.patientId),
  });
}

export function useSubmitOrder(patientId: string) {
  const { invalidate } = useOrderMutations();
  return useMutation({
    mutationFn: (orderId: string) => apiFetch<InfusionOrder>(`/infusion-orders/${orderId}/submit`, { method: 'POST' }),
    onSuccess: () => invalidate(patientId),
  });
}

function useStepAction(patientId: string, action: string) {
  const { invalidate } = useOrderMutations();
  return useMutation({
    mutationFn: (stepId: string) => apiFetch<InfusionStep>(`/infusion-steps/${stepId}/${action}`, { method: 'POST' }),
    onSuccess: () => invalidate(patientId),
  });
}

export function useVerifyStep(patientId: string) {
  const { invalidate } = useOrderMutations();
  return useMutation({
    mutationFn: ({ stepId, dispensedMedicineId, dispensedVolumeMl }: { stepId: string; dispensedMedicineId: string; dispensedVolumeMl: number }) =>
      apiFetch<InfusionStep>(`/infusion-steps/${stepId}/verify`, {
        method: 'POST',
        body: JSON.stringify({ dispensedMedicineId, dispensedVolumeMl }),
      }),
    onSuccess: () => invalidate(patientId),
  });
}

export const useConfirmHighAlert = (patientId: string) => useStepAction(patientId, 'confirm-high-alert');
export const useStartStep = (patientId: string) => useStepAction(patientId, 'start');
export const usePauseStep = (patientId: string) => useStepAction(patientId, 'pause');
export const useResumeStep = (patientId: string) => useStepAction(patientId, 'resume');
export const useCompleteStep = (patientId: string) => useStepAction(patientId, 'complete');

function useStepActionWithReason(patientId: string, action: string) {
  const { invalidate } = useOrderMutations();
  return useMutation({
    mutationFn: ({ stepId, reason }: { stepId: string; reason: string }) =>
      apiFetch<InfusionStep>(`/infusion-steps/${stepId}/${action}`, { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: () => invalidate(patientId),
  });
}

export const useRejectStep = (patientId: string) => useStepActionWithReason(patientId, 'reject');
export const useCancelStep = (patientId: string) => useStepActionWithReason(patientId, 'cancel');

export function useOverrideStep(patientId: string) {
  const { invalidate } = useOrderMutations();
  return useMutation({
    mutationFn: ({ stepId, targetStatus, reason }: { stepId: string; targetStatus: 'RUNNING' | 'CANCELLED'; reason: string }) =>
      apiFetch<InfusionStep>(`/infusion-steps/${stepId}/override`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus, reason }),
      }),
    onSuccess: () => invalidate(patientId),
  });
}
