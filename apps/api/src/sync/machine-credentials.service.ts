import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/types.js';

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

@Injectable()
export class MachineCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Issues a fresh credential for a machine, revoking any existing active
   * ones (rotation, not accumulation). The raw secret is returned exactly
   * once — only its hash is ever stored, mirroring how refresh tokens work.
   */
  async issue(machineId: string, actor: AuthenticatedUser) {
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId } });
    if (!machine) throw new NotFoundException('Machine not found');

    const rawToken = randomBytes(32).toString('hex');
    const credentialHash = hashToken(rawToken);

    await this.prisma.$transaction([
      this.prisma.machineCredential.updateMany({
        where: { machineId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.machineCredential.create({ data: { machineId, credentialHash } }),
    ]);

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'MACHINE_CREDENTIAL_ISSUED',
      entityTable: 'machine_credentials',
      entityId: machineId,
    });

    return { machineId, machineCode: machine.machineCode, token: rawToken };
  }

  /** Hard 401 semantics live in MachineAuthGuard — this only ever returns a match or null, never "allow by default". */
  async verify(machineId: string, rawToken: string): Promise<boolean> {
    const credentialHash = hashToken(rawToken);
    const credential = await this.prisma.machineCredential.findFirst({
      where: { machineId, credentialHash, revokedAt: null },
    });
    if (!credential) return false;

    await this.prisma.machineCredential.update({ where: { id: credential.id }, data: { lastUsedAt: new Date() } });
    return true;
  }
}
