-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'doctor', 'reception', 'pharmacy', 'insurance');

-- CreateEnum
CREATE TYPE "MachineStatus" AS ENUM ('online', 'offline');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('pending_machine_ack', 'accepted', 'rejected');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('draft', 'submitted', 'under_review', 'documents_required', 'approved', 'partially_approved', 'rejected', 'closed');

-- CreateEnum
CREATE TYPE "MedicineStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "StockTransactionType" AS ENUM ('STOCK_IN', 'STOCK_OUT');

-- CreateEnum
CREATE TYPE "MedicineRequestStatus" AS ENUM ('pending', 'fulfilled', 'rejected');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('user', 'machine', 'system');

-- CreateEnum
CREATE TYPE "InfusionOrderStatus" AS ENUM ('draft', 'submitted', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "PumpState" AS ENUM ('RUNNING', 'PAUSED', 'STOPPED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "loginId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "specialty" TEXT,
    "qualification" TEXT,

    CONSTRAINT "doctor_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedByTokenId" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machines" (
    "id" TEXT NOT NULL,
    "machineType" TEXT NOT NULL,
    "machineCode" TEXT NOT NULL,
    "location" TEXT,
    "tailscaleIp" TEXT,
    "status" "MachineStatus" NOT NULL DEFAULT 'offline',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "machines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_credentials" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "credentialHash" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patients" (
    "id" TEXT NOT NULL,
    "ipNumber" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "age" INTEGER NOT NULL,
    "gender" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "emergencyContact" TEXT NOT NULL,
    "aadhar" TEXT NOT NULL,
    "address" TEXT,
    "weightKg" DOUBLE PRECISION,
    "heightCm" DOUBLE PRECISION,
    "bpSystolic" INTEGER,
    "bpDiastolic" INTEGER,
    "heartRate" INTEGER,
    "temperatureF" DOUBLE PRECISION,
    "diagnosis" TEXT,
    "doctorProfileId" TEXT,
    "insured" BOOLEAN NOT NULL DEFAULT false,
    "diabetic" BOOLEAN NOT NULL DEFAULT false,
    "diabeticYears" INTEGER,
    "hypertensive" BOOLEAN NOT NULL DEFAULT false,
    "hypertensiveYears" INTEGER,
    "cva" BOOLEAN NOT NULL DEFAULT false,
    "cad" BOOLEAN NOT NULL DEFAULT false,
    "seizures" BOOLEAN NOT NULL DEFAULT false,
    "thyroid" BOOLEAN NOT NULL DEFAULT false,
    "othersText" TEXT,
    "discharged" BOOLEAN NOT NULL DEFAULT false,
    "dischargeDate" TIMESTAMP(3),
    "dischargeRemarks" TEXT,
    "registeredById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_history" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "actedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "insurance_companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_claims" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "insuranceCompanyId" TEXT,
    "policyNumber" TEXT,
    "memberId" TEXT,
    "relationship" TEXT,
    "policyStart" TIMESTAMP(3),
    "policyEnd" TIMESTAMP(3),
    "tpaName" TEXT,
    "status" "ClaimStatus" NOT NULL DEFAULT 'draft',
    "remarks" TEXT,
    "approvedById" TEXT,
    "cardPhotoPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medicines" (
    "id" TEXT NOT NULL,
    "medicineCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "genericName" TEXT,
    "brand" TEXT,
    "category" TEXT,
    "concentration" TEXT NOT NULL,
    "manufacturer" TEXT,
    "unitMl" DOUBLE PRECISION NOT NULL,
    "stockQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "minStock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reorderLevel" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pricePerUnit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rackNo" INTEGER,
    "channelNo" INTEGER,
    "flushRequired" BOOLEAN NOT NULL DEFAULT false,
    "flushVolumeMl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "highAlert" BOOLEAN NOT NULL DEFAULT false,
    "status" "MedicineStatus" NOT NULL DEFAULT 'ACTIVE',
    "maxFlowRateMlPerH" DOUBLE PRECISION,
    "maxSingleDoseMl" DOUBLE PRECISION,
    "absoluteMaxFlowRateMlPerH" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "medicines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transactions" (
    "id" TEXT NOT NULL,
    "medicineId" TEXT NOT NULL,
    "transactionType" "StockTransactionType" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitCost" DOUBLE PRECISION,
    "supplier" TEXT,
    "invoiceNo" TEXT,
    "patientId" TEXT,
    "machineId" TEXT,
    "isDamaged" BOOLEAN NOT NULL DEFAULT false,
    "paymentMethod" TEXT,
    "subtotalAmount" DOUBLE PRECISION,
    "gstAmount" DOUBLE PRECISION,
    "totalAmount" DOUBLE PRECISION,
    "transactionRef" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medicine_requests" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "medicineId" TEXT,
    "medicineName" TEXT NOT NULL,
    "notes" TEXT,
    "status" "MedicineRequestStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "medicine_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_rejection_reasons" (
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "insurance_rejection_reasons_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorType" "AuditActorType" NOT NULL,
    "action" TEXT NOT NULL,
    "entityTable" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_machine_assignments" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "assignedById" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassignedAt" TIMESTAMP(3),
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'pending_machine_ack',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patient_machine_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "infusion_orders" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "orderedById" TEXT NOT NULL,
    "status" "InfusionOrderStatus" NOT NULL DEFAULT 'draft',
    "clinicalNotes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "infusion_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "infusion_steps" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "medicineId" TEXT NOT NULL,
    "rackNo" INTEGER,
    "channelNo" INTEGER,
    "plannedVolumeMl" DOUBLE PRECISION NOT NULL,
    "plannedRateMlPerH" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "pharmacyVerifiedById" TEXT,
    "pharmacyVerifiedAt" TIMESTAMP(3),
    "highAlertConfirmedById" TEXT,
    "highAlertConfirmedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'pending_machine_ack',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "infusion_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "infusion_step_events" (
    "id" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorUserId" TEXT,
    "actorMachineId" TEXT,
    "reason" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "infusion_step_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "infusion_live_status" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "stepId" TEXT,
    "currentMedicineName" TEXT,
    "remainingVolumeMl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dispensedVolumeMl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "flowRateMlPerH" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "infusedTimeMin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pumpState" "PumpState" NOT NULL DEFAULT 'STOPPED',
    "lastUpdateAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "infusion_live_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_outbox" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "sync_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_inbox_log" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "proposalId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "payload" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_inbox_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_loginId_key" ON "users"("loginId");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_profiles_userId_key" ON "doctor_profiles"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "machines_machineCode_key" ON "machines"("machineCode");

-- CreateIndex
CREATE INDEX "machine_credentials_machineId_idx" ON "machine_credentials"("machineId");

-- CreateIndex
CREATE UNIQUE INDEX "patients_ipNumber_key" ON "patients"("ipNumber");

-- CreateIndex
CREATE INDEX "patient_history_patientId_idx" ON "patient_history"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_companies_name_key" ON "insurance_companies"("name");

-- CreateIndex
CREATE UNIQUE INDEX "medicines_medicineCode_key" ON "medicines"("medicineCode");

-- CreateIndex
CREATE INDEX "stock_transactions_medicineId_idx" ON "stock_transactions"("medicineId");

-- CreateIndex
CREATE INDEX "audit_logs_entityTable_entityId_idx" ON "audit_logs"("entityTable", "entityId");

-- CreateIndex
CREATE INDEX "patient_machine_assignments_patientId_idx" ON "patient_machine_assignments"("patientId");

-- CreateIndex
CREATE INDEX "patient_machine_assignments_machineId_idx" ON "patient_machine_assignments"("machineId");

-- CreateIndex
CREATE INDEX "infusion_orders_patientId_idx" ON "infusion_orders"("patientId");

-- CreateIndex
CREATE INDEX "infusion_orders_machineId_idx" ON "infusion_orders"("machineId");

-- CreateIndex
CREATE INDEX "infusion_steps_orderId_idx" ON "infusion_steps"("orderId");

-- CreateIndex
CREATE INDEX "infusion_step_events_stepId_idx" ON "infusion_step_events"("stepId");

-- CreateIndex
CREATE UNIQUE INDEX "infusion_live_status_machineId_key" ON "infusion_live_status"("machineId");

-- CreateIndex
CREATE INDEX "infusion_live_status_patientId_idx" ON "infusion_live_status"("patientId");

-- CreateIndex
CREATE INDEX "sync_outbox_machineId_status_idx" ON "sync_outbox"("machineId", "status");

-- CreateIndex
CREATE INDEX "sync_inbox_log_machineId_idx" ON "sync_inbox_log"("machineId");

-- AddForeignKey
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_credentials" ADD CONSTRAINT "machine_credentials_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_doctorProfileId_fkey" FOREIGN KEY ("doctorProfileId") REFERENCES "doctor_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_registeredById_fkey" FOREIGN KEY ("registeredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_history" ADD CONSTRAINT "patient_history_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_insuranceCompanyId_fkey" FOREIGN KEY ("insuranceCompanyId") REFERENCES "insurance_companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "medicines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medicine_requests" ADD CONSTRAINT "medicine_requests_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medicine_requests" ADD CONSTRAINT "medicine_requests_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "medicines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_machine_assignments" ADD CONSTRAINT "patient_machine_assignments_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_machine_assignments" ADD CONSTRAINT "patient_machine_assignments_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_machine_assignments" ADD CONSTRAINT "patient_machine_assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infusion_orders" ADD CONSTRAINT "infusion_orders_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infusion_orders" ADD CONSTRAINT "infusion_orders_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infusion_orders" ADD CONSTRAINT "infusion_orders_orderedById_fkey" FOREIGN KEY ("orderedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infusion_steps" ADD CONSTRAINT "infusion_steps_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "infusion_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infusion_steps" ADD CONSTRAINT "infusion_steps_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "medicines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infusion_step_events" ADD CONSTRAINT "infusion_step_events_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "infusion_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infusion_step_events" ADD CONSTRAINT "infusion_step_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infusion_live_status" ADD CONSTRAINT "infusion_live_status_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infusion_live_status" ADD CONSTRAINT "infusion_live_status_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_outbox" ADD CONSTRAINT "sync_outbox_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_inbox_log" ADD CONSTRAINT "sync_inbox_log_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
