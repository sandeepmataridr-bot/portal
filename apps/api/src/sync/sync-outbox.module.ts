import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SyncOutboxService } from './sync-outbox.service.js';
import { SyncGateway } from './sync.gateway.js';
import { SyncDeliveryProcessor } from './sync-delivery.processor.js';
import { MachineCredentialsService } from './machine-credentials.service.js';
import { MachineAuthGuard } from './machine-auth.guard.js';

// Split out of SyncModule so other domain modules (Infusions, Machines,
// Patients) can depend on the outbox/credentials/gateway pieces without
// pulling in SyncController/SyncService — which now need to depend on
// PatientsModule/InfusionsModule themselves (see SyncModule), and doing that
// through the old single module would cycle: SyncModule -> PatientsModule ->
// MachinesModule -> SyncModule.
@Module({
  imports: [AuditModule],
  providers: [SyncOutboxService, SyncGateway, SyncDeliveryProcessor, MachineCredentialsService, MachineAuthGuard],
  exports: [SyncOutboxService, SyncGateway, MachineCredentialsService],
})
export class SyncOutboxModule {}
