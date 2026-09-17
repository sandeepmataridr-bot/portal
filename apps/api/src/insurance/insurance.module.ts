import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { InsuranceController } from './insurance.controller.js';
import { InsuranceService } from './insurance.service.js';

@Module({
  imports: [AuditModule],
  controllers: [InsuranceController],
  providers: [InsuranceService],
})
export class InsuranceModule {}
