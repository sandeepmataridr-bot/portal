import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  vigilIngestSchema,
  vigilRunSchema,
  vigilSpeedSchema,
  vigilStateQuerySchema,
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
  constructor(private readonly vigil: VigilService) {}

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
}
