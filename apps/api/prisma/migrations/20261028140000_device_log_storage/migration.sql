-- Device messages are now stored as bundles (every message kept, ~10 s per row).
-- Existing rows, one message each, become one-message bundles: nothing is lost.
ALTER TABLE "vigil_frames"
  ADD COLUMN "count" INTEGER,
  ADD COLUMN "firstAt" TIMESTAMP(3),
  ADD COLUMN "frames" JSONB;

UPDATE "vigil_frames" SET "frames" = jsonb_build_array("frame"), "count" = 1, "firstAt" = "receivedAt";

ALTER TABLE "vigil_frames"
  ALTER COLUMN "count" SET NOT NULL,
  ALTER COLUMN "firstAt" SET NOT NULL,
  ALTER COLUMN "frames" SET NOT NULL,
  DROP COLUMN "frame";

-- CreateIndex
CREATE INDEX "vigil_frames_machineId_receivedAt_idx" ON "vigil_frames"("machineId", "receivedAt");

-- The machine's own active alarms, one row per machine
CREATE TABLE "machine_alarm_state" (
    "machineId" TEXT NOT NULL,
    "alarms" JSONB NOT NULL,
    "silencedUntil" TIMESTAMP(3),
    "reportedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "machine_alarm_state_pkey" PRIMARY KEY ("machineId")
);

-- The machine's own logs (treatment, alarm, system), kept for good
CREATE TABLE "machine_log_entries" (
    "id" BIGSERIAL NOT NULL,
    "machineId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "event" TEXT NOT NULL,
    "value" TEXT,
    "details" TEXT,
    "category" TEXT,
    "result" TEXT,
    "priority" INTEGER,
    "code" INTEGER,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_log_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "machine_log_entries_machineId_at_idx" ON "machine_log_entries"("machineId", "at");
CREATE UNIQUE INDEX "machine_log_entries_machineId_kind_at_event_key" ON "machine_log_entries"("machineId", "kind", "at", "event");
