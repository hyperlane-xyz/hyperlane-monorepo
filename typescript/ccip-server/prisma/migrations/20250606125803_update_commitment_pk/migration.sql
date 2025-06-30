/*
  Warnings:

  - The primary key for the `Commitment` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- AlterTable
ALTER TABLE "Commitment" DROP CONSTRAINT "Commitment_pkey",
ADD CONSTRAINT "Commitment_pkey" PRIMARY KEY ("revealMessageId");
