import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SyncOutboxModule } from './sync-outbox.module.js';
import { PatientsModule } from '../patients/patients.module.js';
import { InfusionsModule } from '../infusions/infusions.module.js';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.js';
import { DoctorsModule } from '../doctors/doctors.module.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';

@Module({
  imports: [AuditModule, SyncOutboxModule, PatientsModule, InfusionsModule, ReconciliationModule, DoctorsModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
