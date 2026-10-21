import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  createInfusionOrderSchema,
  verifyPharmacyDispenseSchema,
  overrideStepSchema,
  rejectStepSchema,
  INFUSION_STEP_STATUSES,
  ROLES,
  type CreateInfusionOrderInput,
  type VerifyPharmacyDispenseInput,
  type OverrideStepInput,
  type RejectStepInput,
  type InfusionStepStatus,
} from '@infusion/shared-types';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { InfusionsService } from './infusions.service.js';

@Controller()
export class InfusionsController {
  constructor(private readonly infusions: InfusionsService) {}

  @Roles('admin', 'doctor')
  @Post('infusion-orders')
  createOrder(@Body(new ZodValidationPipe(createInfusionOrderSchema)) body: CreateInfusionOrderInput, @CurrentUser() user: AuthenticatedUser) {
    return this.infusions.createOrder(body, user);
  }

  @Roles(...ROLES)
  @Get('infusion-orders/:id')
  getOrder(@Param('id') id: string) {
    return this.infusions.getOrder(id);
  }

  @Roles(...ROLES)
  @Get('patients/:patientId/infusion-orders')
  listForPatient(@Param('patientId') patientId: string) {
    return this.infusions.listOrdersForPatient(patientId);
  }

  @Roles('admin', 'doctor')
  @Post('infusion-orders/:id/submit')
  submitOrder(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.infusions.submitOrder(id, user);
  }

  @Roles('admin', 'pharmacy')
  @Post('infusion-steps/:id/verify')
  verify(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(verifyPharmacyDispenseSchema)) body: VerifyPharmacyDispenseInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.infusions.verifyDispense({ ...body, stepId: id }, user);
  }

  @Roles('admin', 'doctor', 'pharmacy')
  @Post('infusion-steps/:id/confirm-high-alert')
  confirmHighAlert(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.infusions.confirmHighAlert(id, user);
  }

  @Roles('admin', 'doctor')
  @Post('infusion-steps/:id/start')
  start(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.infusions.startStep(id, user);
  }

  @Roles('admin', 'doctor')
  @Post('infusion-steps/:id/pause')
  pause(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.infusions.pauseStep(id, user);
  }

  @Roles('admin', 'doctor')
  @Post('infusion-steps/:id/resume')
  resume(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.infusions.resumeStep(id, user);
  }

  @Roles('admin', 'doctor')
  @Post('infusion-steps/:id/complete')
  complete(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.infusions.completeStep(id, user);
  }

  @Roles('admin', 'doctor', 'pharmacy')
  @Post('infusion-steps/:id/reject')
  reject(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rejectStepSchema)) body: RejectStepInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.infusions.rejectStep(id, body.reason, user);
  }

  @Roles('admin', 'doctor')
  @Post('infusion-steps/:id/cancel')
  cancel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rejectStepSchema)) body: RejectStepInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.infusions.cancelStep(id, body.reason, user);
  }

  @Roles('admin', 'doctor')
  @Post('infusion-steps/:id/override')
  override(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(overrideStepSchema)) body: OverrideStepInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.infusions.overrideStep({ ...body, stepId: id }, user);
  }

  @Roles(...ROLES)
  @Get('machines/:machineId/live-status')
  liveStatus(@Param('machineId') machineId: string) {
    return this.infusions.getLiveStatus(machineId);
  }

  @Roles('admin', 'pharmacy')
  @Get('infusion-steps')
  listByStatus(@Query('status') status?: string) {
    if (!status || !INFUSION_STEP_STATUSES.includes(status as InfusionStepStatus)) {
      throw new BadRequestException(`status query param is required and must be one of: ${INFUSION_STEP_STATUSES.join(', ')}`);
    }
    return this.infusions.listStepsByStatus(status);
  }
}
