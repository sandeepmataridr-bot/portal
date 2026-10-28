import { BadRequestException, Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  MACHINE_LOG_KINDS,
  machineEventsSchema,
  machineHiddenSignalsSchema,
  vigilIngestSchema,
  vigilRunSchema,
  vigilSpeedSchema,
  vigilStateQuerySchema,
  type MachineEventsInput,
  type MachineHiddenSignalsInput,
  type MachineLogKind,
  type VigilIngestInput,
  type VigilRunInput,
  type VigilSpeedInput,
  type VigilStateQuery,
} from '@infusion/shared-types';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { MachineAuthGuard, type MachineRequest } from '../sync/machine-auth.guard.js';
import { MachineEventsService } from './machine-events.service.js';
import { PatientLogExportService } from './patient-log-export.service.js';
import { VigilService } from './vigil.service.js';

/**
 * Vigil central station + ECMO device ingest (docs/vigil/). Clinical
 * actions (acknowledge, confirm association) are attributed to the
 * authenticated user's own loginId — never a typed-in name, unlike the
 * prototype, which had no login. `admin` and `superuser` pass RolesGuard on
 * every route (see its comment); `doctor` is the clinical role here.
 */
@Controller('vigil')
export class VigilController {
  constructor(
    private readonly vigil: VigilService,
    private readonly events: MachineEventsService,
    private readonly logExport: PatientLogExportService,
  ) {}

  // The central station polls this once a second per open screen.
  @Roles('doctor')
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @Get('state')
  state(@Query(new ZodValidationPipe(vigilStateQuerySchema)) query: VigilStateQuery) {
    return this.vigil.state(query.window);
  }

  @Roles('doctor')
  @HttpCode(204)
  @Post('alerts/:id/ack')
  acknowledge(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    this.vigil.acknowledge(id, user);
  }

  @Roles('doctor')
  @HttpCode(204)
  @Post('associations/:id/confirm')
  confirm(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.vigil.confirmAssociation(id, user);
  }

  // TEST mode only (403 in LIVE): start/restart a scenario, change speed.
  @Roles('doctor')
  @Post('test/run')
  run(@Body(new ZodValidationPipe(vigilRunSchema)) body: VigilRunInput) {
    return this.vigil.startTest(body.scenario, body.speed);
  }

  @Roles('doctor')
  @Post('test/speed')
  speed(@Body(new ZodValidationPipe(vigilSpeedSchema)) body: VigilSpeedInput) {
    return this.vigil.setSpeed(body.speed);
  }

  @Roles('admin')
  @Get('audit/verify')
  verify() {
    return this.vigil.verifyAudit();
  }

  /**
   * LIVE mode only: HL7 PCD-01 messages from a registered ECMO machine,
   * authenticated with its machine credential like /sync/push. Machines may
   * push every second, hence the higher per-IP limit.
   */
  @Public()
  @UseGuards(MachineAuthGuard)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Post('ingest')
  ingest(@Body(new ZodValidationPipe(vigilIngestSchema)) body: VigilIngestInput, @Req() req: MachineRequest) {
    return this.vigil.ingest(req.machine!.id, body);
  }

  /**
   * The machine's own active alarms and log entries (ECMO/EBOO HMI), with its machine credential.
   * Stored and shown only: the portal never acknowledges or changes anything on a machine.
   */
  @Public()
  @UseGuards(MachineAuthGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('events')
  reportEvents(@Body(new ZodValidationPipe(machineEventsSchema)) body: MachineEventsInput, @Req() req: MachineRequest) {
    return this.events.report(req.machine!.id, body);
  }

  @Roles('doctor')
  @Get('machines/:machineId/alarms')
  machineAlarms(@Param('machineId') machineId: string) {
    return this.events.alarms(machineId);
  }

  /** Superuser: the machine's values and whether each is shown. */
  @Roles('superuser')
  @Get('machines/:machineId/signals')
  machineSignals(@Param('machineId') machineId: string) {
    return this.vigil.signalOptions(machineId);
  }

  /** Superuser: which values are shown (display only; superuser checked in the service). */
  @Roles('superuser')
  @Patch('machines/:machineId/hidden-signals')
  setHiddenSignals(
    @Param('machineId') machineId: string,
    @Body(new ZodValidationPipe(machineHiddenSignalsSchema)) body: MachineHiddenSignalsInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vigil.setHiddenSignals(machineId, body, user);
  }

  @Roles('doctor')
  @Get('machines/:machineId/log')
  machineLog(
    @Param('machineId') machineId: string,
    @Query('kind') kind?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    const k = (MACHINE_LOG_KINDS as readonly string[]).includes(kind ?? '') ? (kind as MachineLogKind) : undefined;
    return this.events.log(machineId, k, Number(limit) || 50, before && /^\d+$/.test(before) ? before : undefined);
  }

  /**
   * One patient's complete log as a ZIP of CSV files (superuser only; checked in the service, since
   * RolesGuard lets admin through every route). from/to: ISO times; default the whole stay until now.
   */
  @Roles('superuser')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('patients/:patientId/log-export')
  async patientLogExport(
    @Param('patientId') patientId: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const parse = (v: string | undefined, name: string) => {
      if (!v) return undefined;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new BadRequestException(`${name} must be a date and time`);
      return d;
    };
    await this.logExport.export(patientId, { from: parse(from, 'from'), to: parse(to, 'to') }, user, res);
  }
}
