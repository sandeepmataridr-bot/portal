import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { InvalidStepTransitionFilter } from './common/filters/invalid-step-transition.filter.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { envSchema } from './config/env.validation.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { DoctorsModule } from './doctors/doctors.module.js';
import { MachinesModule } from './machines/machines.module.js';
import { RoomsModule } from './rooms/rooms.module.js';
import { PatientsModule } from './patients/patients.module.js';
import { MedicinesModule } from './medicines/medicines.module.js';
import { InsuranceModule } from './insurance/insurance.module.js';
import { InfusionsModule } from './infusions/infusions.module.js';
import { ReconciliationModule } from './reconciliation/reconciliation.module.js';
import { SyncModule } from './sync/sync.module.js';
import { VigilModule } from './vigil/vigil.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: envSchema.parse,
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 100,
      },
    ]),
    PrismaModule,
    AuthModule,
    DoctorsModule,
    MachinesModule,
    RoomsModule,
    PatientsModule,
    MedicinesModule,
    InsuranceModule,
    InfusionsModule,
    ReconciliationModule,
    SyncModule,
    VigilModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_FILTER,
      useClass: InvalidStepTransitionFilter,
    },
  ],
})
export class AppModule {}
