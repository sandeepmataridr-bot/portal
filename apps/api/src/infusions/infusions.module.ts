import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SyncOutboxModule } from '../sync/sync-outbox.module.js';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.js';
import { InfusionsController } from './infusions.controller.js';
import { InfusionsService } from './infusions.service.js';
import { InfusionCapService } from './infusion-cap.service.js';
import { InfusionStepStateMachineService } from './infusion-step-state-machine.service.js';

@Module({
  imports: [AuditModule, SyncOutboxModule, ReconciliationModule],
  controllers: [InfusionsController],
  providers: [InfusionsService, InfusionCapService, InfusionStepStateMachineService],
  exports: [InfusionsService, InfusionCapService, InfusionStepStateMachineService],
})
export class InfusionsModule {}
