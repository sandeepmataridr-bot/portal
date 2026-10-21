-- CreateEnum
CREATE TYPE "ReconciliationKind" AS ENUM ('patient_duplicate', 'medicine_match');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('pending', 'resolved');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'superuser';

-- DropForeignKey
ALTER TABLE "infusion_orders" DROP CONSTRAINT "infusion_orders_orderedById_fkey";

-- DropForeignKey
ALTER TABLE "infusion_steps" DROP CONSTRAINT "infusion_steps_medicineId_fkey";

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "actorMachineId" TEXT;

-- AlterTable
ALTER TABLE "doctor_profiles" ADD COLUMN     "createdByMachineId" TEXT,
ADD COLUMN     "isTemporary" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "infusion_live_status" ADD COLUMN     "pauseTimeSec" INTEGER,
ADD COLUMN     "workingMode" TEXT,
ADD COLUMN     "workingStatusRaw" TEXT;

-- AlterTable
ALTER TABLE "infusion_orders" ADD COLUMN     "orderedByMachineId" TEXT,
ALTER COLUMN "orderedById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "infusion_steps" ADD COLUMN     "concentrationRaw" TEXT,
ADD COLUMN     "medicineNameRaw" TEXT,
ALTER COLUMN "medicineId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "patient_history" ADD COLUMN     "actorMachineId" TEXT,
ADD COLUMN     "actorType" "AuditActorType" NOT NULL DEFAULT 'user';

-- AlterTable
ALTER TABLE "patient_machine_assignments" ADD COLUMN     "assignedByMachineId" TEXT;

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "needsReceptionCompletion" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "registeredByMachineId" TEXT,
ADD COLUMN     "roomOrBed" TEXT,
ALTER COLUMN "ipNumber" DROP NOT NULL,
ALTER COLUMN "mobile" DROP NOT NULL,
ALTER COLUMN "emergencyContact" DROP NOT NULL,
ALTER COLUMN "aadhar" DROP NOT NULL;

-- CreateTable
CREATE TABLE "infusion_telemetry_log" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "stepId" TEXT,
    "flowRateMlPerH" DOUBLE PRECISION NOT NULL,
    "dispensedVolumeMl" DOUBLE PRECISION NOT NULL,
    "remainingVolumeMl" DOUBLE PRECISION NOT NULL,
    "pumpState" "PumpState" NOT NULL,
    "workingMode" TEXT,
    "workingStatusRaw" TEXT,
    "pauseTimeSec" INTEGER,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "infusion_telemetry_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_items" (
    "id" TEXT NOT NULL,
    "kind" "ReconciliationKind" NOT NULL,
    "machineId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "candidates" JSONB,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'pending',
    "resolvedById" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "reconciliation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_commands" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "commandType" TEXT NOT NULL,
    "payload" JSONB,
    "issuedById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "respondedAt" TIMESTAMP(3),
    "result" JSONB,

    CONSTRAINT "machine_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "infusion_telemetry_log_machineId_idx" ON "infusion_telemetry_log"("machineId");

-- CreateIndex
CREATE INDEX "reconciliation_items_status_idx" ON "reconciliation_items"("status");

-- CreateIndex
CREATE INDEX "reconciliation_items_machineId_idx" ON "reconciliation_items"("machineId");

-- CreateIndex
CREATE INDEX "machine_commands_machineId_idx" ON "machine_commands"("machineId");

-- AddForeignKey
ALTER TABLE "infusion_orders" ADD CONSTRAINT "infusion_orders_orderedById_fkey" FOREIGN KEY ("orderedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infusion_steps" ADD CONSTRAINT "infusion_steps_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "medicines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infusion_telemetry_log" ADD CONSTRAINT "infusion_telemetry_log_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_commands" ADD CONSTRAINT "machine_commands_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_commands" ADD CONSTRAINT "machine_commands_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
