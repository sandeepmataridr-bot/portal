import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DischargeOutcome,
  RegisterPatientInput,
  ReadmitPatientInput,
  DischargePatientInput,
  PatientClinicalUpdateInput,
  ChangePatientDoctorInput,
  UpdatePatientIdentityInput,
  LinkPatientsInput,
  UnlinkPatientInput,
} from '@infusion/shared-types';
import { apiFetch } from '../../lib/api';

export interface PatientSummary {
  id: string;
  ipNumber: string;
  fullName: string;
  doctorName: string | null;
  discharged: boolean;
  /** How they left (RECOVERED, REFERRED, LAMA, DIED); null while admitted or for older discharges. */
  dischargeOutcome: DischargeOutcome | null;
  claimStatus: string | null;
  /** IP numbers of duplicate records linked to this one (searching them finds this patient). */
  linkedIpNumbers?: string[];
  room: { id: string; name: string } | null;
}

export interface PatientHistoryEntry {
  id: string;
  patientId: string;
  version: number;
  action: string;
  snapshot: Record<string, unknown>;
  actedBy: string | null;
  createdAt: string;
  /** The IP number this entry was written under (a linked duplicate's, in a combined timeline). */
  ipNumber?: string | null;
}

export interface PatientDetail {
  id: string;
  ipNumber: string;
  fullName: string;
  age: number;
  gender: string;
  mobile: string;
  emergencyContact: string;
  aadhar: string;
  address: string | null;
  weightKg: number | null;
  heightCm: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  heartRate: number | null;
  temperatureF: number | null;
  diagnosis: string | null;
  insured: boolean;
  diabetic: boolean;
  diabeticYears: number | null;
  hypertensive: boolean;
  hypertensiveYears: number | null;
  cva: boolean;
  cad: boolean;
  seizures: boolean;
  thyroid: boolean;
  othersText: string | null;
  discharged: boolean;
  dischargeDate: string | null;
  dischargeRemarks: string | null;
  dischargeOutcome: DischargeOutcome | null;
  doctor: { id: string; name: string } | null;
  history: PatientHistoryEntry[];
  insuranceClaims: Array<{ id: string; status: string; remarks: string | null }>;
  machineAssignments: Array<{ id: string; machineId: string; machine: { machineCode: string; machineType: string } }>;
  room: { id: string; name: string } | null;
  /** Set on a duplicate: the main record it is linked to. */
  linkedTo: LinkedPatientRef | null;
  /** On a main record: its linked duplicates. */
  linkedPatients: LinkedPatientRef[];
}

export interface LinkedPatientRef {
  id: string;
  ipNumber: string | null;
  fullName: string;
}

export interface PatientLinkGroup extends LinkedPatientRef {
  linkedPatients: Array<LinkedPatientRef & { updatedAt: string }>;
}

export interface ReceptionDashboardStats {
  todayPatients: number;
  insurancePending: number;
  approved: number;
  rejected: number;
  discharged: number;
}

export function usePatients(search: string, doctorId?: string) {
  return useQuery({
    queryKey: ['patients', search, doctorId],
    queryFn: () =>
      apiFetch<PatientSummary[]>(
        `/patients?${new URLSearchParams({ ...(search ? { search } : {}), ...(doctorId ? { doctorId } : {}) })}`,
      ),
  });
}

export function usePatient(id: string | null) {
  return useQuery({
    queryKey: ['patients', id],
    queryFn: () => apiFetch<PatientDetail>(`/patients/${id}`),
    enabled: !!id,
  });
}

export function useReceptionDashboard() {
  return useQuery({
    queryKey: ['patients', 'dashboard'],
    queryFn: () => apiFetch<ReceptionDashboardStats>('/patients/dashboard'),
    refetchInterval: 10_000,
  });
}

export function useRegisterPatient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterPatientInput) => apiFetch<PatientDetail>('/patients', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
  });
}

export function useReadmitPatient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ReadmitPatientInput }) =>
      apiFetch<PatientDetail>(`/patients/${id}/readmit`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
  });
}

export function useDischargePatient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: DischargePatientInput }) =>
      apiFetch<PatientDetail>(`/patients/${id}/discharge`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
  });
}

/** Reception/admin: correct identity details (IP number and name stay fixed). */
export function useUpdatePatientIdentity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdatePatientIdentityInput }) =>
      apiFetch<PatientDetail>(`/patients/${id}/identity`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
  });
}

/** Reception/admin: move the patient to another attending doctor (recorded in the history). */
export function useChangePatientDoctor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ChangePatientDoctorInput }) =>
      apiFetch<PatientDetail>(`/patients/${id}/doctor`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
  });
}

export function useUpdatePatientClinical() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: PatientClinicalUpdateInput }) =>
      apiFetch<PatientDetail>(`/patients/${id}/clinical`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['patients'] });
      queryClient.invalidateQueries({ queryKey: ['patients', variables.id] });
    },
  });
}

export function useTagPatientMachine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, machineId }: { id: string; machineId: string }) =>
      apiFetch(`/patients/${id}/machine`, { method: 'PATCH', body: JSON.stringify({ machineId }) }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['patients'] });
      queryClient.invalidateQueries({ queryKey: ['patients', variables.id] });
      queryClient.invalidateQueries({ queryKey: ['machines'] });
    },
  });
}

export function useUntagPatientMachine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, machineId }: { id: string; machineId: string }) =>
      apiFetch(`/patients/${id}/machine/${machineId}`, { method: 'DELETE' }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['patients'] });
      queryClient.invalidateQueries({ queryKey: ['patients', variables.id] });
      queryClient.invalidateQueries({ queryKey: ['machines'] });
    },
  });
}

/** Admin: main records with their linked duplicate IPs. */
export function usePatientLinks() {
  return useQuery({ queryKey: ['patients', 'links'], queryFn: () => apiFetch<PatientLinkGroup[]>('/patients/links') });
}

/** Admin: link duplicate IPs to a main IP (recorded in every timeline involved). */
export function useLinkPatients() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LinkPatientsInput) => apiFetch<PatientDetail>('/patients/links', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
  });
}

/** Admin: delink one duplicate IP from its main IP. */
export function useUnlinkPatient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UnlinkPatientInput }) =>
      apiFetch<PatientDetail>(`/patients/${id}/unlink`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
  });
}
