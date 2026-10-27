-- CreateTable
CREATE TABLE "vigil_frames" (
    "id" BIGSERIAL NOT NULL,
    "machineId" TEXT NOT NULL,
    "machineCode" TEXT NOT NULL,
    "driver" TEXT NOT NULL,
    "frame" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vigil_frames_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vigil_frames_receivedAt_idx" ON "vigil_frames"("receivedAt");
