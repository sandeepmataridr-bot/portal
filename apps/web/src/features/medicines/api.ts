import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpsertMedicineInput, StockInInput, StockOutInput } from '@infusion/shared-types';
import { apiFetch } from '../../lib/api';

export interface Medicine {
  id: string;
  medicineCode: string;
  name: string;
  genericName: string | null;
  brand: string | null;
  category: string | null;
  concentration: string;
  manufacturer: string | null;
  unitMl: number;
  stockQty: number;
  minStock: number;
  reorderLevel: number;
  pricePerUnit: number;
  batchNo: string | null;
  expiryDate: string | null;
  rackNo: number | null;
  channelNo: number | null;
  flushRequired: boolean;
  flushVolumeMl: number;
  highAlert: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  maxFlowRateMlPerH: number | null;
  maxSingleDoseMl: number | null;
  absoluteMaxFlowRateMlPerH: number | null;
}

export interface MedicineDashboard {
  totalMedicines: number;
  inventoryValue: number;
  lowStock: number;
  expired: number;
  expiringSoon: number;
}

export function useMedicines() {
  return useQuery({ queryKey: ['medicines'], queryFn: () => apiFetch<Medicine[]>('/medicines') });
}

export function useMedicineDashboard() {
  return useQuery({
    queryKey: ['medicines', 'dashboard'],
    queryFn: () => apiFetch<MedicineDashboard>('/medicines/dashboard'),
    refetchInterval: 15_000,
  });
}

export function useCreateMedicine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertMedicineInput) => apiFetch<Medicine>('/medicines', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['medicines'] }),
  });
}

export function useUpdateMedicine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpsertMedicineInput }) =>
      apiFetch<Medicine>(`/medicines/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['medicines'] }),
  });
}

export function useStockIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StockInInput) => apiFetch('/medicines/stock-in', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['medicines'] });
      qc.invalidateQueries({ queryKey: ['medicines', 'transactions'] });
    },
  });
}

export function useStockOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StockOutInput) => apiFetch('/medicines/stock-out', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['medicines'] });
      qc.invalidateQueries({ queryKey: ['medicines', 'transactions'] });
    },
  });
}

export function useTransactions(type?: 'STOCK_IN' | 'STOCK_OUT') {
  return useQuery({
    queryKey: ['medicines', 'transactions', type],
    queryFn: () => apiFetch(`/medicines/transactions${type ? `?type=${type}` : ''}`),
  });
}

export function useMedicinesAudit() {
  return useQuery({ queryKey: ['medicines', 'audit'], queryFn: () => apiFetch('/medicines/audit') });
}
