-- CreateTable
CREATE TABLE "Calldata" (
    "commitment" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "data" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "relayers" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Calldata_pkey" PRIMARY KEY ("commitment")
);
