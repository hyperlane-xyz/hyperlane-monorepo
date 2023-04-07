import {
  BridgeAdapterConfig,
  BridgeAdapterType,
  ChainMap,
  Chains,
  chainMetadata,
} from '@hyperlane-xyz/sdk';

const circleDomainMapping = [
  { hyperlaneDomain: chainMetadata[Chains.goerli].chainId, circleDomain: 0 },
  { hyperlaneDomain: chainMetadata[Chains.fuji].chainId, circleDomain: 1 },
];

const wormholeDomainMapping = [
  { hyperlaneDomain: chainMetadata[Chains.goerli].chainId, wormholeDomain: 2 },
  { hyperlaneDomain: chainMetadata[Chains.fuji].chainId, wormholeDomain: 6 },
  { hyperlaneDomain: chainMetadata[Chains.mumbai].chainId, wormholeDomain: 5 },
  {
    hyperlaneDomain: chainMetadata[Chains.bsctestnet].chainId,
    wormholeDomain: 4,
  },
  {
    hyperlaneDomain: chainMetadata[Chains.alfajores].chainId,
    wormholeDomain: 14,
  },
];

export const bridgeAdapterConfigs: ChainMap<BridgeAdapterConfig> = {
  [Chains.goerli]: {
    portal: {
      type: BridgeAdapterType.Portal,
      portalBridgeAddress: '0xF890982f9310df57d00f659cf4fd87e65adEd8d7',
      wormholeDomainMapping,
    },
    circle: {
      type: BridgeAdapterType.Circle,
      tokenMessengerAddress: '0xd0c3da58f55358142b8d3e06c1c30c5c6114efe8',
      messageTransmitterAddress: '0x26413e8157cd32011e726065a5462e97dd4d03d9',
      usdcAddress: '0x07865c6e87b9f70255377e024ace6630c1eaa37f',
      circleDomainMapping,
    },
  },
  [Chains.fuji]: {
    portal: {
      type: BridgeAdapterType.Portal,
      portalBridgeAddress: '0x61E44E506Ca5659E6c0bba9b678586fA2d729756',
      wormholeDomainMapping,
    },
    circle: {
      type: BridgeAdapterType.Circle,
      tokenMessengerAddress: '0xeb08f243e5d3fcff26a9e38ae5520a669f4019d0',
      messageTransmitterAddress: '0xa9fb1b3009dcb79e2fe346c16a604b8fa8ae0a79',
      usdcAddress: '0x5425890298aed601595a70ab815c96711a31bc65',
      circleDomainMapping,
    },
  },
  [Chains.mumbai]: {
    portal: {
      type: BridgeAdapterType.Portal,
      portalBridgeAddress: '0x377D55a7928c046E18eEbb61977e714d2a76472a',
      wormholeDomainMapping,
    },
  },
  [Chains.bsctestnet]: {
    portal: {
      type: BridgeAdapterType.Portal,
      portalBridgeAddress: '0x9dcF9D205C9De35334D646BeE44b2D2859712A09',
      wormholeDomainMapping,
    },
  },
  [Chains.alfajores]: {
    portal: {
      type: BridgeAdapterType.Portal,
      portalBridgeAddress: '0x05ca6037eC51F8b712eD2E6Fa72219FEaE74E153',
      wormholeDomainMapping,
    },
  },
};
