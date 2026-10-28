import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  isVigilMachineType,
  type MachineAlarm,
  type MachineAlarmsView,
  type MachineEventsInput,
  type MachineLogEntryView,
  type MachineLogKind,
} from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The machine's own alarms and logs (ECMO/EBOO HMI). One-way: the machine
 * reports, the portal stores and shows; nothing is ever sent back to it.
 * Active alarms: one row per machine, replaced on every report. Logs: kept for
 * good; a machine repeats an entry until the server has it, and the unique key
 * (machine, kind, time, event) makes repeats harmless; an alarm log entry's
 * status is updated as it changes.
 */
@Injectable()
export class MachineEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async report(machineId: string, input: MachineEventsInput): Promise<{ alarms: number; log: number }> {
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId }, select: { machineType: true } });
    if (!machine) throw new NotFoundException('Machine not found');
    if (!isVigilMachineType(machine.machineType)) throw new ForbiddenException('Only monitoring machines (ECMO, EBOO, monitors) report alarms and logs');

    const now = new Date();
    if (input.alarms !== undefined) {
      const data = { alarms: input.alarms, silencedUntil: input.silencedUntil ? new Date(input.silencedUntil) : null, reportedAt: now };
      await this.prisma.machineAlarmState.upsert({ where: { machineId }, create: { machineId, ...data }, update: data });
    }

    const log = input.log ?? [];
    const rows = log.map((e) => ({
      machineId,
      kind: e.kind,
      at: new Date(e.at),
      event: e.event,
      value: e.value ?? null,
      details: e.details ?? null,
      category: e.category ?? null,
      result: e.result ?? null,
      priority: e.priority ?? null,
      code: e.code ?? null,
    }));
    const plain = rows.filter((r) => r.kind !== 'alarm');
    if (plain.length) await this.prisma.machineLogEntry.createMany({ data: plain, skipDuplicates: true });
    // Alarm log entries change status (Active -> Acknowledged -> Cleared): keep the latest.
    for (const r of rows.filter((x) => x.kind === 'alarm')) {
      await this.prisma.machineLogEntry.upsert({
        where: { machineId_kind_at_event: { machineId, kind: r.kind, at: r.at, event: r.event } },
        create: r,
        update: { result: r.result, value: r.value, details: r.details, priority: r.priority, code: r.code },
      });
    }
    return { alarms: input.alarms?.length ?? 0, log: log.length };
  }

  async alarms(machineId: string): Promise<MachineAlarmsView> {
    const row = await this.prisma.machineAlarmState.findUnique({ where: { machineId } });
    if (!row) return { alarms: [], silencedUntil: null, reportedAt: null };
    return {
      alarms: (Array.isArray(row.alarms) ? row.alarms : []) as MachineAlarm[],
      silencedUntil: row.silencedUntil?.toISOString() ?? null,
      reportedAt: row.reportedAt.toISOString(),
    };
  }

  /** Newest first; `before` (an entry id) pages back. */
  async log(machineId: string, kind: MachineLogKind | undefined, limit: number, before?: string): Promise<MachineLogEntryView[]> {
    const rows = await this.prisma.machineLogEntry.findMany({
      where: { machineId, ...(kind ? { kind } : {}), ...(before ? { id: { lt: BigInt(before) } } : {}) },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 500),
    });
    return rows.map((r) => ({
      id: r.id.toString(),
      kind: r.kind as MachineLogKind,
      at: r.at.toISOString(),
      event: r.event,
      ...(r.value !== null ? { value: r.value } : {}),
      ...(r.details !== null ? { details: r.details } : {}),
      ...(r.category !== null ? { category: r.category } : {}),
      ...(r.result !== null ? { result: r.result } : {}),
      ...(r.priority !== null ? { priority: r.priority } : {}),
      ...(r.code !== null ? { code: r.code } : {}),
    }));
  }
}
