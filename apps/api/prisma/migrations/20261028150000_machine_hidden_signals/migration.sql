-- Signals the superuser hides for a machine (display only; everything is still stored)
ALTER TABLE "machines" ADD COLUMN "hiddenSignals" TEXT[] DEFAULT ARRAY[]::TEXT[];
