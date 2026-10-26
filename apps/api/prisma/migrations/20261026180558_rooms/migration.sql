-- AlterTable
ALTER TABLE "machines" ADD COLUMN     "roomId" TEXT;

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "roomId" TEXT;

-- CreateTable
CREATE TABLE "rooms" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rooms_name_key" ON "rooms"("name");

-- AddForeignKey
ALTER TABLE "machines" ADD CONSTRAINT "machines_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Rooms from the free-text locations already in use: each distinct machine
-- location and bedside patient room (trimmed; same name ignoring case is
-- one room, named as first written). The old text columns are kept.
INSERT INTO "rooms" ("id", "name")
SELECT gen_random_uuid()::text, MIN(name)
FROM (
  SELECT btrim("location") AS name FROM "machines" WHERE btrim(COALESCE("location", '')) <> ''
  UNION ALL
  SELECT btrim("roomOrBed") AS name FROM "patients" WHERE btrim(COALESCE("roomOrBed", '')) <> ''
) AS used
GROUP BY lower(name);

UPDATE "machines" m SET "roomId" = r."id"
FROM "rooms" r
WHERE lower(btrim(m."location")) = lower(r."name");

UPDATE "patients" p SET "roomId" = r."id"
FROM "rooms" r
WHERE lower(btrim(p."roomOrBed")) = lower(r."name");
