export type DispatchEvent = {
  transactionHash?: string;
  blockNumber?: number;
  args?: {
    message?: string;
  } & Record<string, unknown>;
} & Record<string, unknown>;

export type ProcessEvent = {
  transactionHash?: string;
  blockNumber?: number;
  args?: Record<string, unknown>;
} & Record<string, unknown>;

export type HyperlaneLifecyleEvent = ProcessEvent | DispatchEvent;
