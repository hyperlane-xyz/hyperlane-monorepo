import type { ChainName, Token } from '@hyperlane-xyz/sdk';

export type BridgeCapacity = {
  maxSourceInput: bigint;
  maxTargetOutput: bigint;
};

export type BridgeQuoteMode = 'forward' | 'reverse';

export type InventoryMovementExecutionResult =
  | {
      success: true;
      txHash: string;
      inputRequired: bigint;
      quotedOutput: bigint;
      quotedOutputMin: bigint;
      quoteModeUsed: BridgeQuoteMode;
    }
  | {
      success: false;
      error: string;
    };

export type InventorySource = {
  chain: ChainName;
  availableAmount: bigint;
};

export type BridgePlan = {
  chain: ChainName;
  maxSourceInput: bigint;
  targetOutput: bigint;
  quoteMode: BridgeQuoteMode;
};

export type InventoryTransferPlan = {
  sourceToken: Token;
  requestedLocalAmount: bigint;
  availableInventory: bigint;
  maxTransferable: bigint;
  minViableTransfer: bigint;
  totalCost: bigint;
  totalInventory: bigint;
};
