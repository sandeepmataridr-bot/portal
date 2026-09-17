import { Injectable, NotFoundException } from '@nestjs/common';
import { checkInfusionCaps, type CapCheckResult } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Wraps the shared, unit-tested checkInfusionCaps() with a DB lookup for the
 * medicine's configured caps. This is pre-proposal validation (plan §
 * "Dosage/Rate Capping Design") — it runs at order/step authoring time and
 * again at the RUNNING transition, never trusting a value checked once.
 */
@Injectable()
export class InfusionCapService {
  constructor(private readonly prisma: PrismaService) {}

  async check(medicineId: string, requested: { volumeMl: number; rateMlPerH: number }): Promise<CapCheckResult> {
    const medicine = await this.prisma.medicine.findUnique({ where: { id: medicineId } });
    if (!medicine) throw new NotFoundException('Medicine not found');

    return checkInfusionCaps(
      {
        maxFlowRateMlPerH: medicine.maxFlowRateMlPerH,
        maxSingleDoseMl: medicine.maxSingleDoseMl,
        absoluteMaxFlowRateMlPerH: medicine.absoluteMaxFlowRateMlPerH,
      },
      requested,
    );
  }
}
