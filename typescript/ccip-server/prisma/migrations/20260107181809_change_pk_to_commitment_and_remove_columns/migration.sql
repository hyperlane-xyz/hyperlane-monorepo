-- AlterTable: Change primary key from revealMessageId to commitment and remove unused columns

-- First, drop the old primary key
ALTER TABLE "Commitment" DROP CONSTRAINT "Commitment_pkey";

-- Drop columns we don't need
ALTER TABLE "Commitment" DROP COLUMN "commitmentDispatchTx";

-- Remove duplicate commitments (keep the most recent one based on revealMessageId)
DELETE FROM "Commitment" a USING "Commitment" b
WHERE a."commitment" = b."commitment"
AND a."revealMessageId" < b."revealMessageId";

-- Now drop revealMessageId
ALTER TABLE "Commitment" DROP COLUMN "revealMessageId";

-- Add new primary key on commitment
ALTER TABLE "Commitment" ADD CONSTRAINT "Commitment_pkey" PRIMARY KEY ("commitment");
