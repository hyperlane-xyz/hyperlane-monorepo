declare module '@hyperlane-xyz/relayer' {
  export const HyperlaneRelayer: any;
  export const RelayerCacheSchema: any;
}

declare module '@hyperlane-xyz/rebalancer' {
  export const RebalancerService: any;
  export const RebalancerConfig: any;
  export const RebalancerConfigSchema: any;
  export type RebalancerConfigFileInput = any;
  export const getStrategyChainNames: any;
}

declare module '@hyperlane-xyz/keyfunder' {
  export const KeyFunder: any;
  export const ContextFunderConfigSchema: any;
  export const KeyFunderConfigSchema: any;
}

declare module '@hyperlane-xyz/metrics' {
  export const metrics: any;
  export const registerBalanceGauges: any;
  export const startMetricsServer: any;
  export const CoreMetrics: any;
  export const RelayerMetrics: any;
  export const submitMetrics: any;
}
