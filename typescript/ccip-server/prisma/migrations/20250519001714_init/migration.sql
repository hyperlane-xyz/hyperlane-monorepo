-- CreateTable
CREATE TABLE "Commitment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "calls" JSONB NOT NULL,
    "relayers" JSONB NOT NULL,
    "salt" TEXT NOT NULL,
    "ica" TEXT NOT NULL,
    "commitmentDispatchTx" TEXT,
    "originDomain" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
