import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CLAIM_STATUSES,
  claimDecisionSchema,
  claimRevokeSchema,
  ROLES,
  type ClaimDecisionInput,
  type ClaimRevokeInput,
  type ClaimStatus,
} from '@infusion/shared-types';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { InsuranceService } from './insurance.service.js';

@Controller('insurance')
export class InsuranceController {
  constructor(private readonly insurance: InsuranceService) {}

  @Roles(...ROLES)
  @Get('companies')
  listCompanies() {
    return this.insurance.listCompanies();
  }

  @Roles('insurance', 'admin')
  @Get('rejection-reasons')
  listRejectionReasons() {
    return this.insurance.listRejectionReasons();
  }

  @Roles('insurance', 'admin')
  @Get('claims')
  listClaims(@Query('status') status?: string, @Query('search') search?: string) {
    if (status !== undefined && !CLAIM_STATUSES.includes(status as ClaimStatus)) {
      throw new BadRequestException(`Invalid status filter. Must be one of: ${CLAIM_STATUSES.join(', ')}`);
    }
    return this.insurance.listClaims(status as ClaimStatus | undefined, search);
  }

  @Roles('insurance', 'admin')
  @Post('claims/:id/decision')
  decide(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(claimDecisionSchema)) body: ClaimDecisionInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.insurance.decide(id, body, user);
  }

  @Roles('insurance', 'admin')
  @Post('claims/:id/revoke')
  revoke(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(claimRevokeSchema)) body: ClaimRevokeInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.insurance.revoke(id, body, user);
  }
}
