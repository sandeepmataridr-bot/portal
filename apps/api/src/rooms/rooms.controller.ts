import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ROLES, createRoomSchema, updateRoomSchema, type CreateRoomInput, type UpdateRoomInput } from '@infusion/shared-types';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { RoomsService } from './rooms.service.js';

@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  /** Active rooms for every role's room pickers; ?all=true also lists inactive ones. */
  @Roles(...ROLES)
  @Get()
  list(@Query('all') all?: string) {
    return this.rooms.list(all === 'true');
  }

  @Roles('admin')
  @Post()
  create(@Body(new ZodValidationPipe(createRoomSchema)) body: CreateRoomInput, @CurrentUser() user: AuthenticatedUser) {
    return this.rooms.create(body, user);
  }

  @Roles('admin')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateRoomSchema)) body: UpdateRoomInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rooms.update(id, body, user);
  }
}
