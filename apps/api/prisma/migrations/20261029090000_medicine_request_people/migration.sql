-- Who raised a medicine request and who fulfilled or rejected it (login IDs, as in the patient timeline)
ALTER TABLE "medicine_requests" ADD COLUMN "requestedBy" TEXT;
ALTER TABLE "medicine_requests" ADD COLUMN "resolvedBy" TEXT;
ALTER TABLE "medicine_requests" ADD COLUMN "resolvedAt" TIMESTAMP(3);
