import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from '../audit/audit.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { TestLoginsService } from './test-logins.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { StaffThrottlerGuard } from './guards/staff-throttler.guard.js';

@Module({
  imports: [JwtModule.register({}), AuditModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    TestLoginsService,
    // Global, deny-by-default auth: JwtAuthGuard runs first (populates
    // req.user), then RolesGuard enforces the permission matrix. Registered
    // here (not AppModule) so their dependencies resolve from this module's
    // own providers.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Rate limits: per person for signed-in staff, per address otherwise (StaffThrottlerGuard).
    { provide: APP_GUARD, useClass: StaffThrottlerGuard },
  ],
  exports: [TokenService, PasswordService],
})
export class AuthModule {}
