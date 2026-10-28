import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { Zip, ZipDeflate } from 'fflate';
import { Normalizer, SIGNALS, SIGNAL_ORDER, parseOru } from '@infusion/vigil';
import { DISCHARGE_OUTCOME_LABEL, MACHINE_TYPE_LABEL, type DischargeOutcome, type MachineType } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { signalsFor } from './machine-signals.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/types.js';

/** Stored device-message bundles read per database query while exporting. */
const BATCH = 200;
const enc = new TextEncoder();

/** One CSV field: quoted when it holds a comma, quote or line break. */
function csv(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const row = (fields: unknown[]) => `${fields.map(csv).join(',')}\r\n`;

/**
 * The superuser's download of one patient's complete log, as a ZIP of CSV
 * files (opens in any spreadsheet): the patient and their timeline, the
 * portal's Vigil alerts for them, and a folder per machine they were on with
 * everything that machine reported while it was tagged to them (every
 * reading, its own treatment / alarm / system logs, its alarms) and what the
 * portal did with it. Streamed while it is read, so months of ECMO data never
 * sit in memory.
 */
@Injectable()
export class PatientLogExportService {
  private readonly logger = new Logger(PatientLogExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async export(patientId: string, range: { from?: Date; to?: Date }, actor: AuthenticatedUser, res: Response): Promise<void> {
    // RolesGuard lets admin through every route: the download is the superuser's alone.
    if (actor.role !== 'superuser') throw new ForbiddenException('Patient logs are downloaded by the superuser');
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      include: {
        doctor: { select: { name: true } },
        room: { select: { name: true } },
        history: { orderBy: { version: 'asc' } },
        machineAssignments: { orderBy: { assignedAt: 'asc' }, include: { machine: true, assignedBy: { select: { loginId: true } } } },
      },
    });
    if (!patient) throw new NotFoundException('Patient not found');

    const to = range.to ?? new Date();
    const from = range.from ?? patient.createdAt;
    const stamp = to.toISOString().slice(0, 10);
    const safeName = patient.fullName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const fileName = `patient-${patient.ipNumber ?? 'no-ip'}-${safeName}-log-${stamp}.zip`;

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'PATIENT_LOG_DOWNLOADED',
      entityTable: 'patients',
      entityId: patientId,
      after: { from: from.toISOString(), to: to.toISOString() },
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');

    const zip = new Zip((err, data, final) => {
      if (err) {
        this.logger.error(`patient log export failed: ${err.message}`);
        res.destroy(err);
        return;
      }
      res.write(Buffer.from(data));
      if (final) res.end();
    });
    const drain = () => (res.writableNeedDrain ? new Promise<void>((r) => res.once('drain', () => r())) : Promise.resolve());
    const file = (name: string) => {
      const f = new ZipDeflate(name, { level: 6 });
      zip.add(f);
      // CSV files start with the UTF-8 byte order mark, so Excel shows °C, SvO₂ and names correctly.
      if (name.endsWith('.csv')) f.push(enc.encode('﻿'));
      return {
        write: (text: string) => f.push(enc.encode(text)),
        end: (text = '') => f.push(enc.encode(text), true),
      };
    };

    const machines = new Map<string, { code: string; type: string; windows: { start: Date; end: Date }[] }>();
    for (const a of patient.machineAssignments) {
      const start = new Date(Math.max(a.assignedAt.getTime(), from.getTime()));
      const end = new Date(Math.min((a.unassignedAt ?? to).getTime(), to.getTime()));
      if (end <= start) continue;
      const m = machines.get(a.machineId) ?? { code: a.machine.machineCode, type: a.machine.machineType, windows: [] };
      m.windows.push({ start, end });
      machines.set(a.machineId, m);
    }

    const readme = file('README.txt');
    readme.end(
      [
        `Patient log: ${patient.fullName} (IP ${patient.ipNumber ?? '-'})`,
        `Period: ${from.toISOString()} to ${to.toISOString()} (times are UTC)`,
        `Downloaded by ${actor.loginId} at ${new Date().toISOString()}`,
        '',
        'patient.csv          the patient record',
        'timeline.csv         every change to the record (registration, doctor, room, machines, discharge ...)',
        'vigil-alerts.csv     the portal\'s own alerts for this patient (raised, acknowledged, resolved) and machine links',
        'signals.csv          what each readings column is: name, unit, and what coded numbers mean',
        'machines/<code>/     one folder per machine the patient was on, only the time it was tagged to them:',
        '  assignments.csv      when it was tagged and untagged',
        '  readings.csv         every message the machine sent, one row each (ECMO, EBOO, monitors)',
        '  pump-telemetry.csv   infusion pumps: every live status report',
        '  treatment-log.csv, alarm-log.csv, system-log.csv   the machine\'s own logs',
        '  portal-events.csv    what the portal recorded about the machine (tagging, credentials, rooms)',
        '',
        'The portal only shows and records what machines report; it never controls a machine.',
        '',
      ].join('\r\n'),
    );

    const p = file('patient.csv');
    p.write(row(['IP number', 'Name', 'Age', 'Gender', 'Mobile', 'Doctor', 'Room', 'Registered', 'Diagnosis', 'Discharged', 'Discharge date', 'Outcome', 'Remarks']));
    p.end(
      row([
        patient.ipNumber,
        patient.fullName,
        patient.age,
        patient.gender,
        patient.mobile,
        patient.doctor?.name,
        patient.room?.name ?? 'Out patient',
        patient.createdAt,
        patient.diagnosis,
        patient.discharged ? 'yes' : 'no',
        patient.dischargeDate,
        patient.dischargeOutcome ? DISCHARGE_OUTCOME_LABEL[patient.dischargeOutcome as DischargeOutcome] : '',
        patient.dischargeRemarks,
      ]),
    );

    const t = file('timeline.csv');
    t.write(row(['Time', 'Action', 'By', 'Version', 'Details']));
    for (const h of patient.history) t.write(row([h.createdAt, h.action, h.actedBy, h.version, h.snapshot]));
    t.end();

    // The portal's own records for this patient: its alerts (raised, acknowledged, resolved) and the
    // machine links (associations: made, confirmed at the bedside, ended). Later records of an alert or
    // a link carry only its id, so they are found through the first one.
    const ledger = await this.prisma.$queryRaw<{ at: Date; kind: string; data: Record<string, unknown> }[]>`
      SELECT "at", "kind", "data" FROM "vigil_audit_ledger"
      WHERE "mode" = 'live' AND "at" BETWEEN ${from} AND ${to}
        AND ("data"->>'encounter_id' = ${patientId}
             OR "data"->>'alert_id' IN (SELECT "data"->>'alert_id' FROM "vigil_audit_ledger" WHERE "data"->>'encounter_id' = ${patientId})
             OR "data"->>'association_id' IN (SELECT "data"->>'association_id' FROM "vigil_audit_ledger" WHERE "data"->>'encounter_id' = ${patientId}))
      ORDER BY "seq"`;
    const EVENT: Record<string, string> = {
      alert_raised: 'Alert raised',
      alert_acknowledged: 'Alert acknowledged',
      alert_resolved: 'Alert resolved',
      association: 'Machine linked',
      association_confirmed: 'Machine link confirmed at the bedside',
      association_ended: 'Machine link ended',
    };
    const va = file('vigil-alerts.csv');
    va.write(row(['Time', 'Event', 'Machine', 'Alert id', 'Rule', 'Priority', 'Explanation', 'By']));
    for (const a of ledger) {
      const d = a.data;
      const explanation = d.explanation ?? d.reason ?? (d.therapy ? `therapy ${String(d.therapy)}${d.confirmed ? ', confirmed' : ''}` : '');
      va.write(row([a.at, EVENT[a.kind] ?? a.kind, d.device_id, d.alert_id, d.rule, d.priority, explanation, d.acknowledged_by || d.confirmed_by || d.by]));
    }
    va.end();

    // What every readings column is: name, unit and, for coded values, what each number means.
    const codes = [...new Set([...machines.values()].filter((m) => m.type !== 'INFUSION_PUMP').flatMap((m) => signalsFor(m.type)))];
    const legend = file('signals.csv');
    legend.write(row(['Column', 'Code', 'Unit', 'Kind', 'Values']));
    for (const c of SIGNAL_ORDER.filter((x) => codes.includes(x))) {
      const s = SIGNALS[c];
      const values = s.states ? s.states.map((name, i) => `${i} = ${name}`).join('; ') : s.unit === 'flag' ? '0 = off / normal; 1 = on / alarm' : '';
      legend.write(row([`${s.description} (${s.unit})`, c, s.unit, s.kind, values]));
    }
    legend.end();
    await drain();

    for (const [machineId, m] of machines) {
      const dir = `machines/${m.code.replace(/[^A-Za-z0-9_-]+/g, '_')}`;
      const inWindow = (d: Date) => m.windows.some((w) => d >= w.start && d <= w.end);

      const as = file(`${dir}/assignments.csv`);
      as.write(row(['Machine', 'Type', 'Tagged', 'Untagged', 'Tagged by']));
      for (const a of patient.machineAssignments.filter((x) => x.machineId === machineId)) {
        as.write(row([m.code, MACHINE_TYPE_LABEL[m.type as MachineType] ?? m.type, a.assignedAt, a.unassignedAt ?? 'still tagged', a.assignedBy?.loginId]));
      }
      as.end();

      if (m.type === 'INFUSION_PUMP') {
        const pt = file(`${dir}/pump-telemetry.csv`);
        pt.write(row(['Time', 'Pump state', 'Status', 'Mode', 'Flow rate (mL/h)', 'Dispensed (mL)', 'Remaining (mL)', 'Pause (s)', 'Step id']));
        for (const w of m.windows) {
          let cursor: string | undefined;
          for (;;) {
            const rows = await this.prisma.infusionTelemetryLog.findMany({
              where: { machineId, recordedAt: { gte: w.start, lte: w.end } },
              orderBy: { id: 'asc' },
              take: 2000,
              ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            });
            for (const r of rows) {
              pt.write(row([r.recordedAt, r.pumpState, r.workingStatusRaw, r.workingMode, r.flowRateMlPerH, r.dispensedVolumeMl, r.remainingVolumeMl, r.pauseTimeSec, r.stepId]));
            }
            await drain();
            if (rows.length < 2000) break;
            cursor = rows[rows.length - 1].id;
          }
        }
        pt.end();
      } else {
        await this.writeReadings(file(`${dir}/readings.csv`), machineId, m, drain);
      }

      const logs = await this.prisma.machineLogEntry.findMany({ where: { machineId }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
      const kept = logs.filter((l) => inWindow(l.at));
      const tl = file(`${dir}/treatment-log.csv`);
      tl.write(row(['Time', 'Event', 'Value']));
      for (const l of kept.filter((x) => x.kind === 'treatment')) tl.write(row([l.at, l.event, l.value]));
      tl.end();
      const al = file(`${dir}/alarm-log.csv`);
      al.write(row(['Time', 'Code', 'Alarm', 'Value', 'Limit', 'Priority', 'Status']));
      for (const l of kept.filter((x) => x.kind === 'alarm')) {
        al.write(row([l.at, l.code, l.event, l.value, l.details, ['', 'Low', 'Medium', 'High'][l.priority ?? 0] ?? l.priority, l.result]));
      }
      al.end();
      const sl = file(`${dir}/system-log.csv`);
      sl.write(row(['Time', 'Category', 'Event', 'Details', 'Result']));
      for (const l of kept.filter((x) => x.kind === 'system')) sl.write(row([l.at, l.category, l.event, l.details, l.result]));
      sl.end();

      const assignmentIds = patient.machineAssignments.filter((x) => x.machineId === machineId).map((x) => x.id);
      const events = await this.prisma.auditLog.findMany({
        where: {
          OR: [{ entityId: machineId }, { actorMachineId: machineId }, { entityTable: 'patient_machine_assignments', entityId: { in: assignmentIds } }],
          createdAt: { gte: from, lte: to },
        },
        orderBy: { createdAt: 'asc' },
        include: { actor: { select: { loginId: true } } },
      });
      const pe = file(`${dir}/portal-events.csv`);
      pe.write(row(['Time', 'Action', 'By', 'Before', 'After']));
      for (const e of events) pe.write(row([e.createdAt, e.action, e.actor?.loginId ?? (e.actorMachineId ? m.code : e.actorType), e.before, e.after]));
      pe.end();
      await drain();
    }
    zip.end();
  }

  /** Every stored message of the machine inside its windows, one row per message, columns per signal. */
  private async writeReadings(
    out: { write: (t: string) => void; end: (t?: string) => void },
    machineId: string,
    m: { code: string; type: string; windows: { start: Date; end: Date }[] },
    drain: () => Promise<void>,
  ): Promise<void> {
    const columns = signalsFor(m.type);
    const index = new Map(columns.map((c, i) => [c, i]));
    out.write(row(['Time (UTC)', ...columns.map((c) => `${SIGNALS[c].description} (${SIGNALS[c].unit})`)]));
    const normalizer = Normalizer.withDefaults();
    for (const w of m.windows) {
      let cursor: bigint | null = null;
      for (;;) {
        const bundles: { id: bigint; driver: string; frames: unknown }[] = await this.prisma.vigilFrame.findMany({
          where: {
            machineId,
            receivedAt: { gte: w.start },
            firstAt: { lte: w.end },
            ...(cursor === null ? {} : { id: { gt: cursor } }),
          },
          orderBy: { id: 'asc' },
          take: BATCH,
          select: { id: true, driver: true, frames: true },
        });
        for (const b of bundles) {
          for (const frame of Array.isArray(b.frames) ? (b.frames as string[]) : []) {
            let samples;
            try {
              samples = parseOru(frame);
            } catch {
              continue;                    // was accepted when it arrived; never expected
            }
            if (!samples.length) continue;
            const t = samples[0].deviceTime;
            if (t * 1000 < w.start.getTime() || t * 1000 > w.end.getTime()) continue;
            const values: unknown[] = columns.map(() => '');
            for (const s of samples) {
              try {
                const obs = normalizer.normalize(b.driver, s, '');
                const i = index.get(obs.code);
                if (i !== undefined) values[i] = Math.round(obs.value * 1000) / 1000;
              } catch {
                // a value in an unknown unit: left empty
              }
            }
            out.write(row([new Date(t * 1000).toISOString(), ...values]));
          }
        }
        await drain();
        if (bundles.length < BATCH) break;
        cursor = bundles[bundles.length - 1].id;
      }
    }
    out.end();
  }
}
