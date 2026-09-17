import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';
import { SyncOutboxService } from './sync-outbox.service.js';
import { SyncGateway } from './sync.gateway.js';
import { SyncDeliveryProcessor } from './sync-delivery.processor.js';
import { MachineCredentialsService } from './machine-credentials.service.js';
import { MachineAuthGuard } from './machine-auth.guard.js';

@Module({
  imports: [AuditModule],
  controllers: [SyncController],
  providers: [SyncService, SyncOutboxService, SyncGateway, SyncDeliveryProcessor, MachineCredentialsService, MachineAuthGuard],
  exports: [SyncOutboxService, SyncGateway, MachineCredentialsService],
})
export class SyncModule {}
