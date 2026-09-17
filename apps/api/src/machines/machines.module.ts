import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { MachinesController } from './machines.controller.js';
import { MachinesService } from './machines.service.js';

@Module({
  imports: [AuditModule, SyncModule],
  controllers: [MachinesController],
  providers: [MachinesService],
  exports: [MachinesService],
})
export class MachinesModule {}
