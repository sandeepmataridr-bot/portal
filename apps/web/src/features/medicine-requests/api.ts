import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateMedicineRequestInput } from '@infusion/shared-types';
import { apiFetch } from '../../lib/api';

export interface MedicineRequest {
  id: string;
  patientId: string;
  patient: { fullName: string; ipNumber: string };
  medicineId: string | null;
  medicine: { name: string; concentration: string } | null;
  medicineName: string;
  notes: string | null;
  status: 'pending' | 'fulfilled' | 'rejected';
  createdAt: string;
}

export function useMedicineRequests() {
  return useQuery({ queryKey: ['medicine-requests'], queryFn: () => apiFetch<MedicineRequest[]>('/medicine-requests') });
}

export function useCreateMedicineRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMedicineRequestInput) =>
      apiFetch<MedicineRequest>('/medicine-requests', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['medicine-requests'] }),
  });
}

export function useUpdateMedicineRequestStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'fulfilled' | 'rejected' }) =>
      apiFetch<MedicineRequest>(`/medicine-requests/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['medicine-requests'] }),
  });
}
