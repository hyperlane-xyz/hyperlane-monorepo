import {
  BridgeAdapterType,
  ChainMap,
  Chains,
  CircleBridgeAdapterConfig,
  chainMetadata,
} from '@hyperlane-xyz/sdk';

const circleDomainMapping = [
  { hyperlaneDomain: chainMetadata[Chains.goerli].id, circleDomain: 0 },
  { hyperlaneDomain: chainMetadata[Chains.fuji].id, circleDomain: 1 },
];

export const circleBridgeAdapterConfig: ChainMap<
  any,
  CircleBridgeAdapterConfig
> = {
  [Chains.goerli]: {
    type: BridgeAdapterType.Circle,
    circleBridgeAddress: '0xdabec94b97f7b5fca28f050cc8eeac2dc9920476',
    messageTransmitterAddress: '0x40a61d3d2afcf5a5d31fcdf269e575fb99dd87f7',
    usdcAddress: '0x07865c6e87b9f70255377e024ace6630c1eaa37f',
    circleDomainMapping,
  },
  [Chains.fuji]: {
    type: BridgeAdapterType.Circle,
    circleBridgeAddress: '0x0fc1103927af27af808d03135214718bcedbe9ad',
    messageTransmitterAddress: '0x52fffb3ee8fa7838e9858a2d5e454007b9027c3c',
    usdcAddress: '0x5425890298aed601595a70ab815c96711a31bc65',
    circleDomainMapping,
  },
};
