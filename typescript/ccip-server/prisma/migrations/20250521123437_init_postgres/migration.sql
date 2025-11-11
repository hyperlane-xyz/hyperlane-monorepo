-- CreateTable
CREATE TABLE "Commitment" (
    "commitment" TEXT NOT NULL,
    "revealMessageId" TEXT NOT NULL,
    "calls" JSONB NOT NULL,
    "relayers" JSONB NOT NULL,
    "salt" TEXT NOT NULL,
    "ica" TEXT NOT NULL,
    "commitmentDispatchTx" TEXT NOT NULL,
    "originDomain" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Commitment_pkey" PRIMARY KEY ("commitment","revealMessageId")
);
