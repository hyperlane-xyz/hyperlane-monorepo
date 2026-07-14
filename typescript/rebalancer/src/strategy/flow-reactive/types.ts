export const FLOW_SCALE = 1000n;

export type FlowRecord = {
  chain: string;
  amount: bigint;
  timestamp: number;
};

export type FlowSignal = {
  chain: string;
  magnitude: bigint;
  direction: 'surplus' | 'deficit';
};

export type FlowWindow = {
  records: FlowRecord[];
  startTime: number;
};

export type FlowReactiveParams = {
  windowSizeMs: number;
  minSamplesForSignal: number;
  coldStartCycles: number;
};

export type EMAFlowParams = FlowReactiveParams & {
  alpha: number;
  alphaScale: bigint;
};
