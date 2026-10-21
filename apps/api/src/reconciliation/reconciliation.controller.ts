import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { resolveReconciliationItemSchema, type ResolveReconciliationItemInput } from '@infusion/shared-types';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { ReconciliationService } from './reconciliation.service.js';

@Controller('reconciliation-items')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Roles('admin', 'reception')
  @Get()
  list(@Query('status') status?: string, @Query('kind') kind?: string) {
    return this.reconciliation.list(status, kind);
  }

  @Roles('admin', 'reception')
  @Get(':id')
  getById(@Param('id') id: string) {
    return this.reconciliation.getById(id);
  }

  @Roles('admin', 'reception')
  @Post(':id/resolve')
  resolve(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(resolveReconciliationItemSchema)) body: ResolveReconciliationItemInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reconciliation.resolve(id, body, user);
  }
}
