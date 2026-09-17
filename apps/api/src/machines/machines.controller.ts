import { Body, Controller, Get, Post } from '@nestjs/common';
import { createMachineSchema, ROLES, type CreateMachineInput } from '@infusion/shared-types';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { MachinesService } from './machines.service.js';

@Controller('machines')
export class MachinesController {
  constructor(private readonly machines: MachinesService) {}

  @Roles(...ROLES)
  @Get()
  list() {
    return this.machines.listAll();
  }

  @Roles(...ROLES)
  @Get('fleet-status')
  fleetStatus() {
    return this.machines.fleetStatus();
  }

  @Roles('admin')
  @Post()
  create(@Body(new ZodValidationPipe(createMachineSchema)) body: CreateMachineInput, @CurrentUser() user: AuthenticatedUser) {
    return this.machines.create(body, user);
  }
}
