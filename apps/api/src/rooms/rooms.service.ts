import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateRoomInput, UpdateRoomInput } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/types.js';

/**
 * The admin's list of ICU rooms/beds. Machines and patients pick from it, so
 * "same room" is an exact match and a machine can never be tagged to a
 * patient in another room (MachinesService.assignPatientToMachine).
 */
@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(includeInactive: boolean) {
    const rooms = await this.prisma.room.findMany({
      where: includeInactive ? {} : { active: true },
      include: { _count: { select: { machines: true, patients: { where: { discharged: false } } } } },
      orderBy: { name: 'asc' },
    });
    return rooms.map((r) => ({
      id: r.id,
      name: r.name,
      active: r.active,
      machineCount: r._count.machines,
      patientCount: r._count.patients,
    }));
  }

  async create(input: CreateRoomInput, actor: AuthenticatedUser) {
    await this.assertNameFree(input.name);
    const room = await this.prisma.room.create({ data: { name: input.name } });
    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'ROOM_CREATED',
      entityTable: 'rooms',
      entityId: room.id,
      after: { name: room.name },
    });
    return room;
  }

  async update(id: string, input: UpdateRoomInput, actor: AuthenticatedUser) {
    const room = await this.prisma.room.findUnique({
      where: { id },
      include: { _count: { select: { machines: true, patients: { where: { discharged: false } } } } },
    });
    if (!room) throw new NotFoundException('Room not found');
    if (input.name !== undefined && input.name.toLowerCase() !== room.name.toLowerCase()) await this.assertNameFree(input.name);
    if (input.active === false && (room._count.machines || room._count.patients)) {
      throw new ConflictException(
        `${room.name} still has ${room._count.machines} machine(s) and ${room._count.patients} admitted patient(s); move them first`,
      );
    }
    const updated = await this.prisma.room.update({ where: { id }, data: { name: input.name, active: input.active } });
    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'ROOM_UPDATED',
      entityTable: 'rooms',
      entityId: id,
      before: { name: room.name, active: room.active },
      after: { name: updated.name, active: updated.active },
    });
    return updated;
  }

  /** An active room by id, for moves and registrations. */
  async requireActive(id: string) {
    const room = await this.prisma.room.findUnique({ where: { id } });
    if (!room || !room.active) throw new NotFoundException('Choose an active room');
    return room;
  }

  private async assertNameFree(name: string) {
    const clash = await this.prisma.room.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (clash) throw new ConflictException(`A room named ${clash.name} already exists`);
  }
}
