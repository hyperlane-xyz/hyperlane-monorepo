ALTER TABLE "Calldata" RENAME COLUMN "chainId" TO "originDomain";
ALTER TABLE "Calldata" RENAME COLUMN "userSalt" TO "destinationAccount";
UPDATE "Calldata" SET "destinationAccount" = '' WHERE "destinationAccount" IS NULL;
ALTER TABLE "Calldata" ALTER COLUMN "destinationAccount" SET NOT NULL;
