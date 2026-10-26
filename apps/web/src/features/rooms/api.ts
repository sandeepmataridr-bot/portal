import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateRoomInput, Room, UpdateRoomInput } from '@infusion/shared-types';
import { apiFetch } from '../../lib/api';

/** The admin's room list; active rooms only unless includeInactive. */
export function useRooms(includeInactive = false) {
  return useQuery({
    queryKey: ['rooms', includeInactive],
    queryFn: () => apiFetch<Room[]>(`/rooms${includeInactive ? '?all=true' : ''}`),
  });
}

export function useCreateRoom() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoomInput) => apiFetch<Room>('/rooms', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rooms'] }),
  });
}

export function useUpdateRoom() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateRoomInput }) =>
      apiFetch<Room>(`/rooms/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rooms'] }),
  });
}

/** Admin moves a machine to another room. */
export function useMoveMachine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ machineId, roomId }: { machineId: string; roomId: string }) =>
      apiFetch(`/machines/${machineId}/room`, { method: 'PATCH', body: JSON.stringify({ roomId }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['machines'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
    },
  });
}

/** Reception/admin moves a patient (their machines move with them). */
export function useMovePatient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ patientId, roomId, note }: { patientId: string; roomId: string; note?: string }) =>
      apiFetch(`/patients/${patientId}/room`, { method: 'PATCH', body: JSON.stringify({ roomId, note }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['patients'] });
      queryClient.invalidateQueries({ queryKey: ['machines'] });
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
    },
  });
}
