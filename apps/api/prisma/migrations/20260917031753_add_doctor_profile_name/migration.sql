/*
  Warnings:

  - Added the required column `name` to the `doctor_profiles` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "doctor_profiles" ADD COLUMN     "name" TEXT NOT NULL;
