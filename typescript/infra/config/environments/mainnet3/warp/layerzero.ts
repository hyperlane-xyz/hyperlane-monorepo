export type LayerZeroDomainConfig = {
  lzChainId: number;
  dstVault: string;
  adapterParams: string;
};

export type LayerZeroBridgeConfig = {
  [hyperlaneDomain: number]: LayerZeroDomainConfig;
};
