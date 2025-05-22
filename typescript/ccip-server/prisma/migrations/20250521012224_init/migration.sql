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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("commitment", "revealMessageId")
);
