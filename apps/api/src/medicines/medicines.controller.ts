import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  upsertMedicineSchema,
  stockInSchema,
  stockOutSchema,
  ROLES,
  type UpsertMedicineInput,
  type StockInInput,
  type StockOutInput,
} from '@infusion/shared-types';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { MedicinesService } from './medicines.service.js';

@Controller('medicines')
export class MedicinesController {
  constructor(private readonly medicines: MedicinesService) {}

  @Roles(...ROLES)
  @Get()
  list() {
    return this.medicines.list();
  }

  @Roles('pharmacy', 'admin')
  @Get('dashboard')
  dashboard() {
    return this.medicines.dashboard();
  }

  @Roles('pharmacy', 'admin')
  @Get('transactions')
  transactions(@Query('type') type?: 'STOCK_IN' | 'STOCK_OUT') {
    return this.medicines.transactions(type);
  }

  @Roles('pharmacy', 'admin')
  @Get('audit')
  auditLog() {
    return this.medicines.auditLog();
  }

  @Roles('pharmacy', 'admin')
  @Post()
  create(@Body(new ZodValidationPipe(upsertMedicineSchema)) body: UpsertMedicineInput, @CurrentUser() user: AuthenticatedUser) {
    return this.medicines.create(body, user);
  }

  @Roles('pharmacy', 'admin')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(upsertMedicineSchema)) body: UpsertMedicineInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.medicines.update(id, body, user);
  }

  @Roles('pharmacy', 'admin')
  @Post('stock-in')
  stockIn(@Body(new ZodValidationPipe(stockInSchema)) body: StockInInput, @CurrentUser() user: AuthenticatedUser) {
    return this.medicines.stockIn(body, user);
  }

  @Roles('pharmacy', 'admin')
  @Post('stock-out')
  stockOut(@Body(new ZodValidationPipe(stockOutSchema)) body: StockOutInput, @CurrentUser() user: AuthenticatedUser) {
    return this.medicines.stockOut(body, user);
  }
}
