import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { MedicinesController } from './medicines.controller.js';
import { MedicinesService } from './medicines.service.js';
import { MedicineRequestsController } from './medicine-requests.controller.js';
import { MedicineRequestsService } from './medicine-requests.service.js';

@Module({
  imports: [AuditModule],
  controllers: [MedicinesController, MedicineRequestsController],
  providers: [MedicinesService, MedicineRequestsService],
  exports: [MedicinesService],
})
export class MedicinesModule {}
