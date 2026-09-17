import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { MachineCredentialsService } from './machine-credentials.service.js';

export interface MachineRequest extends Request {
  machine?: { id: string };
}

/**
 * Direct fix for the reference app's confirmed bug (app.py:3759-3761): a
 * machine with no configured credential was silently treated as authorized.
 * Here, missing or invalid credentials are always a hard 401 — never a
 * fallback-allow.
 */
@Injectable()
export class MachineAuthGuard implements CanActivate {
  constructor(private readonly credentials: MachineCredentialsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<MachineRequest>();
    const machineId = request.headers['x-machine-id'];
    const token = request.headers['x-machine-token'];

    if (typeof machineId !== 'string' || typeof token !== 'string' || !machineId || !token) {
      throw new UnauthorizedException('Missing machine credentials');
    }

    const valid = await this.credentials.verify(machineId, token);
    if (!valid) {
      throw new UnauthorizedException('Invalid machine credentials');
    }

    request.machine = { id: machineId };
    return true;
  }
}
