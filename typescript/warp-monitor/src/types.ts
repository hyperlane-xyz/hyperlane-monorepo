export interface WarpNativeDustConfig {
  privateKey: string;
  defaultAmount: string;
  amountByChain?: Record<string, string>;
  maxRecipientBalance?: string;
  sourceChains?: string[];
  destinationChains?: string[];
  eventLookbackBlocks?: number;
}

export interface WarpMonitorConfig {
  warpRouteId: string;
  checkFrequency: number;
  coingeckoApiKey?: string;
  registryUri?: string;
  explorerApiUrl?: string;
  explorerQueryLimit?: number;
  inventoryAddress?: string;
  nativeDusting?: WarpNativeDustConfig;
}
