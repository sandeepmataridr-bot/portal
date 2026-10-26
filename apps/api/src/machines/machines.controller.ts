import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  createMachineSchema,
  moveMachineSchema,
  sendMachineCommandSchema,
  ROLES,
  type CreateMachineInput,
  type MoveMachineInput,
  type SendMachineCommandInput,
} from '@infusion/shared-types';
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

  // Admin moves a machine to another room (refused while it is on a patient
  // in a different room).
  @Roles('admin')
  @Patch(':id/room')
  move(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(moveMachineSchema)) body: MoveMachineInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.machines.moveToRoom(id, body.roomId, user);
  }

  // superuser-only, deliberately not admin — this is the one narrow exception
  // to "machine always decides" (see the plan's "Super-user remote commands"
  // section), scoped to the single role built for full accountability.
  @Roles('superuser')
  @Post(':id/commands')
  sendCommand(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(sendMachineCommandSchema)) body: SendMachineCommandInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.machines.sendCommand(id, body, user);
  }

  @Roles('superuser')
  @Get(':id/commands')
  listCommands(@Param('id') id: string) {
    return this.machines.listCommands(id);
  }
}
