export type LayerZeroDomainConfig = {
  lzChainId: number;
  dstVault: string;
  adapterParams: string;
};

export type LayerZeroBridgeConfig = {
  [hyperlaneDomain: number]: LayerZeroDomainConfig;
};

export type OFTAdapterParams = {
  domainConfig: LayerZeroBridgeConfig;
};

export class OftBridgeAdapter {
  constructor(private params: OFTAdapterParams) {}

  quoteTransferRemote(_destination: number, _recipient: string, _amount: string) {
    return [{ token: "native", amount: "0" }];
  }

  async transferRemote(_destination: number, _recipient: string, _amount: string) {
    return "0x";
  }
}
