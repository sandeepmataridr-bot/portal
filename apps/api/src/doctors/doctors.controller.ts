import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  createDoctorSchema,
  updateDoctorSchema,
  type CreateDoctorInput,
  type UpdateDoctorInput,
} from '@infusion/shared-types';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { DoctorsService } from './doctors.service.js';

@Controller('doctors')
export class DoctorsController {
  constructor(private readonly doctors: DoctorsService) {}

  // Used by registration/order forms across roles — active doctors only.
  @Roles('admin', 'doctor', 'reception', 'pharmacy', 'insurance')
  @Get()
  list() {
    return this.doctors.listActive();
  }

  @Roles('admin')
  @Get('all')
  listAll(@Query('inactive') inactive?: string) {
    return this.doctors.listAll(inactive === 'true');
  }

  @Roles('admin')
  @Post()
  create(@Body(new ZodValidationPipe(createDoctorSchema)) body: CreateDoctorInput, @CurrentUser() user: AuthenticatedUser) {
    return this.doctors.create(body, user);
  }

  @Roles('admin')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateDoctorSchema)) body: UpdateDoctorInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.doctors.update(id, body, user);
  }

  @Roles('admin')
  @Post(':id/archive')
  archive(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.doctors.setActive(id, false, user);
  }

  @Roles('admin')
  @Post(':id/unarchive')
  unarchive(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.doctors.setActive(id, true, user);
  }

  @Roles('admin')
  // Credential-issuing endpoint — throttle even for an authenticated admin,
  // in case that session/token is itself compromised.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/reset-password')
  resetPassword(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.doctors.resetPassword(id, user);
  }

  @Roles('admin')
  @Get(':id/history')
  history(@Param('id') id: string) {
    return this.doctors.getHistory(id);
  }
}
