import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DoctorSummary, CreateDoctorInput, UpdateDoctorInput, CreateDoctorResult, ResetDoctorPasswordResult } from '@infusion/shared-types';
import { apiFetch } from '../../lib/api';

export function useActiveDoctors() {
  return useQuery({
    queryKey: ['doctors', 'active'],
    queryFn: () => apiFetch<DoctorSummary[]>('/doctors'),
  });
}

export function useAllDoctors(includeInactive: boolean) {
  return useQuery({
    queryKey: ['doctors', 'all', includeInactive],
    queryFn: () => apiFetch<DoctorSummary[]>(`/doctors/all?inactive=${includeInactive}`),
  });
}

function useInvalidateDoctors() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['doctors'] });
  };
}

export function useCreateDoctor() {
  const invalidate = useInvalidateDoctors();
  return useMutation({
    mutationFn: (input: CreateDoctorInput) => apiFetch<CreateDoctorResult>('/doctors', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: invalidate,
  });
}

export function useUpdateDoctor() {
  const invalidate = useInvalidateDoctors();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateDoctorInput }) =>
      apiFetch<DoctorSummary>(`/doctors/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: invalidate,
  });
}

export function useArchiveDoctor() {
  const invalidate = useInvalidateDoctors();
  return useMutation({
    mutationFn: (id: string) => apiFetch<DoctorSummary>(`/doctors/${id}/archive`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useUnarchiveDoctor() {
  const invalidate = useInvalidateDoctors();
  return useMutation({
    mutationFn: (id: string) => apiFetch<DoctorSummary>(`/doctors/${id}/unarchive`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useResetDoctorPassword() {
  const invalidate = useInvalidateDoctors();
  return useMutation({
    mutationFn: (id: string) => apiFetch<ResetDoctorPasswordResult>(`/doctors/${id}/reset-password`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function usePromoteDoctor() {
  const invalidate = useInvalidateDoctors();
  return useMutation({
    mutationFn: (id: string) => apiFetch<CreateDoctorResult>(`/doctors/${id}/promote`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useDoctorHistory(id: string | null) {
  return useQuery({
    queryKey: ['doctors', id, 'history'],
    queryFn: () => apiFetch(`/doctors/${id}/history`),
    enabled: !!id,
  });
}
