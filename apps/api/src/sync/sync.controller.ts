import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { syncPullRequestSchema, syncPushRequestSchema, type SyncPullRequest, type SyncPushRequest } from '@infusion/shared-types';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { MachineAuthGuard, type MachineRequest } from './machine-auth.guard.js';
import { MachineCredentialsService } from './machine-credentials.service.js';
import { SyncService } from './sync.service.js';

@Controller('sync')
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly credentials: MachineCredentialsService,
  ) {}

  @Public()
  @UseGuards(MachineAuthGuard)
  @Post('pull')
  pull(@Body(new ZodValidationPipe(syncPullRequestSchema)) body: SyncPullRequest, @Req() req: MachineRequest) {
    return this.sync.pull(req.machine!.id, body);
  }

  @Public()
  @UseGuards(MachineAuthGuard)
  @Post('push')
  push(@Body(new ZodValidationPipe(syncPushRequestSchema)) body: SyncPushRequest, @Req() req: MachineRequest) {
    return this.sync.push(req.machine!.id, body);
  }

  @Roles('admin')
  // Issues the machine's long-lived secret — shown only once. Throttle it
  // like any other credential-issuing endpoint.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('machines/:id/credentials')
  issueCredential(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.credentials.issue(id, user);
  }
}
