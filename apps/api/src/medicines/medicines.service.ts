import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { UpsertMedicineInput, StockInInput, StockOutInput } from '@infusion/shared-types';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/types.js';

const GST_RATE = 0.18;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

@Injectable()
export class MedicinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.medicine.findMany({ orderBy: { name: 'asc' } });
  }

  async dashboard() {
    const medicines = await this.prisma.medicine.findMany();
    const now = new Date();
    const in30Days = new Date(now.getTime() + 30 * 86_400_000);

    return {
      totalMedicines: medicines.length,
      inventoryValue: round2(medicines.reduce((sum, m) => sum + m.stockQty * m.pricePerUnit, 0)),
      lowStock: medicines.filter((m) => m.status === 'ACTIVE' && m.stockQty <= m.reorderLevel).length,
      expired: medicines.filter((m) => m.expiryDate && m.expiryDate < now).length,
      expiringSoon: medicines.filter((m) => m.expiryDate && m.expiryDate >= now && m.expiryDate <= in30Days).length,
    };
  }

  async create(input: UpsertMedicineInput, actor: AuthenticatedUser) {
    const existing = await this.prisma.medicine.findUnique({ where: { medicineCode: input.medicineCode } });
    if (existing) throw new BadRequestException(`Medicine code ${input.medicineCode} already exists`);

    const medicine = await this.prisma.medicine.create({
      data: { ...input, expiryDate: input.expiryDate ? new Date(input.expiryDate) : undefined },
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'MEDICINE_CREATED',
      entityTable: 'medicines',
      entityId: medicine.id,
      after: { medicineCode: medicine.medicineCode, name: medicine.name },
    });
    return medicine;
  }

  async update(id: string, input: UpsertMedicineInput, actor: AuthenticatedUser) {
    const existing = await this.prisma.medicine.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Medicine not found');

    const medicine = await this.prisma.medicine.update({
      where: { id },
      data: { ...input, expiryDate: input.expiryDate ? new Date(input.expiryDate) : undefined },
    });

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'MEDICINE_UPDATED',
      entityTable: 'medicines',
      entityId: id,
      before: { stockQty: existing.stockQty, status: existing.status },
      after: { stockQty: medicine.stockQty, status: medicine.status },
    });
    return medicine;
  }

  async stockIn(input: StockInInput, actor: AuthenticatedUser) {
    const medicine = await this.prisma.medicine.findUnique({ where: { id: input.medicineId } });
    if (!medicine) throw new NotFoundException('Medicine not found');

    const [, transaction] = await this.prisma.$transaction([
      this.prisma.medicine.update({ where: { id: input.medicineId }, data: { stockQty: { increment: input.quantity } } }),
      this.prisma.stockTransaction.create({
        data: {
          medicineId: input.medicineId,
          transactionType: 'STOCK_IN',
          quantity: input.quantity,
          unitCost: input.unitCost,
          supplier: input.supplier,
          invoiceNo: input.invoiceNo,
          remarks: input.remarks,
        },
      }),
    ]);

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'STOCK_IN',
      entityTable: 'stock_transactions',
      entityId: transaction.id,
      after: { medicineId: input.medicineId, quantity: input.quantity },
    });
    return transaction;
  }

  async stockOut(input: StockOutInput, actor: AuthenticatedUser) {
    const medicine = await this.prisma.medicine.findUnique({ where: { id: input.medicineId } });
    if (!medicine) throw new NotFoundException('Medicine not found');
    if (medicine.stockQty < input.quantity) throw new BadRequestException('Insufficient stock');

    let claimStatus: string | undefined;
    if (input.patientId) {
      const patient = await this.prisma.patient.findUnique({
        where: { id: input.patientId },
        include: { insuranceClaims: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      if (!patient) throw new NotFoundException('Patient not found');
      claimStatus = patient.insuranceClaims[0]?.status;
    }

    if (input.paymentMethod === 'Insurance') {
      if (input.isDamaged) throw new BadRequestException('Insurance payment cannot be used for Damaged/Expiry');
      if (claimStatus !== 'approved') {
        throw new BadRequestException("Insurance payment is only allowed if the patient's claim is Approved.");
      }
    }

    const subtotalAmount = round2(input.quantity * medicine.pricePerUnit);
    const gstAmount = round2(subtotalAmount * GST_RATE);
    const totalAmount = round2(subtotalAmount + gstAmount);

    const [, transaction] = await this.prisma.$transaction([
      this.prisma.medicine.update({ where: { id: input.medicineId }, data: { stockQty: { decrement: input.quantity } } }),
      this.prisma.stockTransaction.create({
        data: {
          medicineId: input.medicineId,
          transactionType: 'STOCK_OUT',
          quantity: input.quantity,
          patientId: input.isDamaged ? undefined : input.patientId,
          machineId: input.machineId,
          isDamaged: input.isDamaged,
          paymentMethod: input.paymentMethod,
          subtotalAmount,
          gstAmount,
          totalAmount,
          transactionRef: input.transactionRef,
          remarks: input.remarks,
        },
      }),
    ]);

    await this.audit.log({
      actorUserId: actor.id,
      actorType: 'user',
      action: 'STOCK_OUT',
      entityTable: 'stock_transactions',
      entityId: transaction.id,
      after: { medicineId: input.medicineId, quantity: input.quantity, totalAmount },
    });
    return transaction;
  }

  transactions(type?: 'STOCK_IN' | 'STOCK_OUT') {
    return this.prisma.stockTransaction.findMany({
      where: type ? { transactionType: type } : undefined,
      include: { medicine: true, patient: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  auditLog() {
    return this.prisma.auditLog.findMany({
      where: { entityTable: { in: ['medicines', 'stock_transactions'] } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
}
