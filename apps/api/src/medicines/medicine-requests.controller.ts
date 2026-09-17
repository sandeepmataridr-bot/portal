import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  createMedicineRequestSchema,
  updateMedicineRequestStatusSchema,
  type CreateMedicineRequestInput,
  type UpdateMedicineRequestStatusInput,
} from '@infusion/shared-types';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { MedicineRequestsService } from './medicine-requests.service.js';

@Controller('medicine-requests')
export class MedicineRequestsController {
  constructor(private readonly requests: MedicineRequestsService) {}

  @Roles('doctor', 'admin')
  @Post()
  create(@Body(new ZodValidationPipe(createMedicineRequestSchema)) body: CreateMedicineRequestInput, @CurrentUser() user: AuthenticatedUser) {
    return this.requests.create(body, user);
  }

  @Roles('pharmacy', 'admin')
  @Get()
  list() {
    return this.requests.list();
  }

  @Roles('pharmacy', 'admin')
  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateMedicineRequestStatusSchema)) body: UpdateMedicineRequestStatusInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.requests.updateStatus(id, body.status, user);
  }
}
