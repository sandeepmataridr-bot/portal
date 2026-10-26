import { z } from 'zod';

/**
 * ICU rooms/beds, kept by the admin. Machines and patients pick a room from
 * this list, and a machine can only be tagged to a patient in its own room.
 */
export const roomSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  active: z.boolean(),
  machineCount: z.number().int(),
  patientCount: z.number().int(),
});
export type Room = z.infer<typeof roomSchema>;

export const createRoomSchema = z.object({
  name: z.string().trim().min(1, 'Room name is required').max(60),
});
export type CreateRoomInput = z.infer<typeof createRoomSchema>;

export const updateRoomSchema = z
  .object({
    name: z.string().trim().min(1, 'Room name is required').max(60).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.active !== undefined, { message: 'Nothing to change' });
export type UpdateRoomInput = z.infer<typeof updateRoomSchema>;

/** Admin moves a machine to another room (refused while it is on a patient in a different room). */
export const moveMachineSchema = z.object({ roomId: z.string().uuid('Choose a room') });
export type MoveMachineInput = z.infer<typeof moveMachineSchema>;

/** Reception/admin moves a patient; machines attached to them move too. */
export const movePatientSchema = z.object({
  roomId: z.string().uuid('Choose a room'),
  note: z.string().trim().max(500).optional(),
});
export type MovePatientInput = z.infer<typeof movePatientSchema>;
