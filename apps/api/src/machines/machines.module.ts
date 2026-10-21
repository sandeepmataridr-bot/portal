import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SyncOutboxModule } from '../sync/sync-outbox.module.js';
import { InfusionsModule } from '../infusions/infusions.module.js';
import { MachinesController } from './machines.controller.js';
import { MachinesService } from './machines.service.js';

@Module({
  // AuthModule (PasswordService, for command password re-confirmation) and
  // InfusionsModule (InfusionCapService, for the flow-rate-adjust hard gate)
  // are safe additions here — neither imports MachinesModule back, unlike
  // PatientsModule which already depends on MachinesModule the other way.
  imports: [AuditModule, AuthModule, SyncOutboxModule, InfusionsModule],
  controllers: [MachinesController],
  providers: [MachinesService],
  exports: [MachinesService],
})
export class MachinesModule {}
