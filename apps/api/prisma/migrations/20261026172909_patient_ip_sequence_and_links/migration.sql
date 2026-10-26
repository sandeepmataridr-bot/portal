-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "linkedToPatientId" TEXT;

-- CreateIndex
CREATE INDEX "patients_linkedToPatientId_idx" ON "patients"("linkedToPatientId");

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_linkedToPatientId_fkey" FOREIGN KEY ("linkedToPatientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Automatic IP numbers: 6 digits, next in sequence, for reception and
-- machine-created patients alike (PatientsService.nextIpNumber). The
-- sequence continues after the highest numeric IP already in use.
CREATE SEQUENCE "patient_ip_seq" MINVALUE 1 MAXVALUE 999999 NO CYCLE;
SELECT setval(
  'patient_ip_seq',
  GREATEST(COALESCE((SELECT MAX("ipNumber"::integer) FROM "patients" WHERE "ipNumber" ~ '^\d{1,6}$'), 0), 0) + 1,
  false
);

-- Patients created at the bedside had no IP number: give them the next
-- numbers, oldest first.
DO $$
DECLARE missing RECORD;
BEGIN
  FOR missing IN SELECT "id" FROM "patients" WHERE "ipNumber" IS NULL ORDER BY "createdAt", "id" LOOP
    UPDATE "patients" SET "ipNumber" = lpad(nextval('patient_ip_seq')::text, 6, '0') WHERE "id" = missing."id";
  END LOOP;
END $$;
