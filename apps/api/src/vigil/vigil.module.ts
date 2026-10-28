import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SyncOutboxModule } from '../sync/sync-outbox.module.js';
import { MachineEventsService } from './machine-events.service.js';
import { PatientLogExportService } from './patient-log-export.service.js';
import { VigilAuditService } from './vigil-audit.service.js';
import { VigilController } from './vigil.controller.js';
import { VigilService } from './vigil.service.js';

// Vigil ECMO monitoring (docs/vigil/, ADR-006). SyncOutboxModule provides
// MachineCredentialsService for the machine-authenticated ingest route.
@Module({
  imports: [AuditModule, SyncOutboxModule],
  controllers: [VigilController],
  providers: [VigilService, VigilAuditService, MachineEventsService, PatientLogExportService],
  exports: [MachineEventsService],
})
export class VigilModule {}
