-- AlterTable
ALTER TABLE "patient_machine_assignments" ADD COLUMN     "vigilConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "vigilConfirmedById" TEXT;

-- CreateTable
CREATE TABLE "vigil_audit_ledger" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "prev" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "vigil_audit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vigil_audit_ledger_mode_seq_key" ON "vigil_audit_ledger"("mode", "seq");

-- AddForeignKey
ALTER TABLE "patient_machine_assignments" ADD CONSTRAINT "patient_machine_assignments_vigilConfirmedById_fkey" FOREIGN KEY ("vigilConfirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Vigil's hash-chained audit ledger is insert-only, enforced in the database
-- with the same trigger function as every other log table (see migration
-- 20260919005222_immutable_log_tables_guard for why a trigger, not REVOKE).
CREATE TRIGGER vigil_audit_ledger_immutable
  BEFORE UPDATE OR DELETE ON vigil_audit_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_log_mutation();
