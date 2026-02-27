export type DispatchEvent = {
  transactionHash?: string;
  blockNumber?: number;
  args?: {
    message?: string;
  };
};

export type ProcessEvent = {
  transactionHash?: string;
  blockNumber?: number;
  args?: Record<string, unknown>;
};

export type HyperlaneLifecyleEvent = ProcessEvent | DispatchEvent;
