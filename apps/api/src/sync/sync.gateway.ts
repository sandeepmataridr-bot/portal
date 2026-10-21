import { Logger } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Prisma } from '@prisma/client';
import type { Server, Socket } from 'socket.io';
import { REALTIME_EVENTS } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { MachineCredentialsService } from './machine-credentials.service.js';

/**
 * Real-time channel layered on top of the pull/push REST model (see
 * docs/sync-contract.md) — a latency optimization, never the only path.
 * Machines authenticate on connect with the same credentials as the REST
 * endpoints (never a separate, weaker check); staff dashboards join the
 * shared 'dashboard' room for live fleet updates.
 */
@WebSocketGateway({ cors: { origin: true, credentials: true }, namespace: '/realtime' })
export class SyncGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;

  private readonly logger = new Logger(SyncGateway.name);
  private readonly connectedMachines = new Map<string, string>(); // machineId -> socketId

  constructor(
    private readonly credentials: MachineCredentialsService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket) {
    const machineId = client.handshake.query.machineId as string | undefined;
    const token = client.handshake.query.token as string | undefined;
    const isDashboard = client.handshake.query.dashboard === 'true';

    if (machineId && token) {
      const valid = await this.credentials.verify(machineId, token);
      if (!valid) {
        this.logger.warn(`Rejected machine WS connection for ${machineId} — invalid credentials`);
        client.disconnect(true);
        return;
      }
      this.connectedMachines.set(machineId, client.id);
      await client.join(`machine:${machineId}`);
      this.logger.log(`Machine ${machineId} connected`);

      // Real connectivity tracking — previously Machine.status just sat at
      // its `offline` default forever (verified: nothing anywhere else in
      // the API ever wrote to it), silently zeroing out the fleet
      // dashboard's "connected" count. This is the one place that actually
      // knows a machine's live socket state, so it's the right owner of it.
      await this.prisma.machine.update({ where: { id: machineId }, data: { status: 'online', lastSeenAt: new Date() } });
      this.broadcastToDashboard(REALTIME_EVENTS.machineStatusChanged, { machineId, status: 'online' });
      return;
    }

    if (isDashboard) {
      // Staff dashboard connections are JWT-protected at the HTTP layer that
      // issues the page; this socket only needs the room join for now.
      await client.join('dashboard');
      return;
    }

    client.disconnect(true);
  }

  handleDisconnect(client: Socket) {
    for (const [machineId, socketId] of this.connectedMachines.entries()) {
      if (socketId === client.id) {
        this.connectedMachines.delete(machineId);
        this.logger.log(`Machine ${machineId} disconnected`);
        void this.prisma.machine
          .update({ where: { id: machineId }, data: { status: 'offline', lastSeenAt: new Date() } })
          .then(() => this.broadcastToDashboard(REALTIME_EVENTS.machineStatusChanged, { machineId, status: 'offline' }));
      }
    }
  }

  isConnected(machineId: string): boolean {
    return this.connectedMachines.has(machineId);
  }

  emitToMachine(machineId: string, event: string, payload: unknown) {
    this.server.to(`machine:${machineId}`).emit(event, payload);
  }

  broadcastToDashboard(event: string, payload: unknown) {
    this.server.to('dashboard').emit(event, payload);
  }

  private machineIdForSocket(socketId: string): string | undefined {
    for (const [machineId, id] of this.connectedMachines.entries()) {
      if (id === socketId) return machineId;
    }
    return undefined;
  }

  /**
   * How a machine reports back on a superuser remote command (plan §
   * "Super-user remote commands" — "report the result back
   * (ACKNOWLEDGED/FAILED with a reason)"). Only trusted from the socket
   * already authenticated as the owning machine — never accepted as a claim
   * of "I am machine X" over an unauthenticated channel.
   */
  // The app's global guards (JwtAuthGuard, RolesGuard, ThrottlerGuard — all
  // registered via APP_GUARD in app.module.ts) are HTTP-oriented and crash
  // against a WS execution context (confirmed live: JwtAuthGuard reading
  // `request.headers.authorization` on an undefined request; ThrottlerGuard
  // calling `res.header(...)` with no res) — this is the app's first
  // @SubscribeMessage handler, which is what first exercised that path.
  // @Public() is the right fix, not a workaround: this message has its own,
  // separate authentication — machineIdForSocket() below only resolves for a
  // socket that already passed MachineCredentialsService.verify() in
  // handleConnection, exactly mirroring how the machine-facing HTTP routes
  // use @Public() + a dedicated MachineAuthGuard instead of JWT.
  @Public()
  @SkipThrottle()
  @SubscribeMessage('machine.command_result')
  async handleCommandResult(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { commandId: string; status: 'ACKNOWLEDGED' | 'FAILED'; result?: Record<string, unknown> },
  ) {
    const machineId = this.machineIdForSocket(client.id);
    if (!machineId) return; // not an authenticated machine connection — ignore

    const command = await this.prisma.machineCommand.findUnique({ where: { id: data.commandId } });
    if (!command || command.machineId !== machineId) return;

    const updated = await this.prisma.machineCommand.update({
      where: { id: data.commandId },
      data: {
        status: data.status,
        respondedAt: new Date(),
        result: (data.result ?? null) as Prisma.InputJsonValue | undefined,
      },
    });

    this.broadcastToDashboard(REALTIME_EVENTS.machineCommandUpdated, {
      machineId,
      commandId: updated.id,
      status: updated.status,
    });
  }
}
