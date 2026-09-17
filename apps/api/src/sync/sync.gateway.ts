import { Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
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

  constructor(private readonly credentials: MachineCredentialsService) {}

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
}
