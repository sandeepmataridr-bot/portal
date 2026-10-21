import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { MachinesModule } from '../machines/machines.module.js';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.js';
import { PatientsController } from './patients.controller.js';
import { PatientsService } from './patients.service.js';

@Module({
  imports: [AuditModule, MachinesModule, ReconciliationModule],
  controllers: [PatientsController],
  providers: [PatientsService],
  exports: [PatientsService],
})
export class PatientsModule {}
