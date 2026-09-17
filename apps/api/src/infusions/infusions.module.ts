import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { InfusionsController } from './infusions.controller.js';
import { InfusionsService } from './infusions.service.js';
import { InfusionCapService } from './infusion-cap.service.js';
import { InfusionStepStateMachineService } from './infusion-step-state-machine.service.js';

@Module({
  imports: [AuditModule, SyncModule],
  controllers: [InfusionsController],
  providers: [InfusionsService, InfusionCapService, InfusionStepStateMachineService],
  exports: [InfusionCapService, InfusionStepStateMachineService],
})
export class InfusionsModule {}
