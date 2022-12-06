import {
  BridgeAdapterConfig,
  BridgeAdapterType,
  ChainMap,
  Chains,
  chainMetadata,
} from '@hyperlane-xyz/sdk';

const circleDomainMapping = [
  { hyperlaneDomain: chainMetadata[Chains.goerli].id, circleDomain: 0 },
  { hyperlaneDomain: chainMetadata[Chains.fuji].id, circleDomain: 1 },
];

const wormholeDomainMapping = [
  { hyperlaneDomain: chainMetadata[Chains.goerli].id, wormholeDomain: 2 },
  { hyperlaneDomain: chainMetadata[Chains.fuji].id, wormholeDomain: 6 },
  { hyperlaneDomain: chainMetadata[Chains.mumbai].id, wormholeDomain: 5 },
  { hyperlaneDomain: chainMetadata[Chains.bsctestnet].id, wormholeDomain: 4 },
  { hyperlaneDomain: chainMetadata[Chains.alfajores].id, wormholeDomain: 14 },
];

export const bridgeAdapterConfigs: ChainMap<any, BridgeAdapterConfig> = {
  [Chains.goerli]: {
    portal: {
      type: BridgeAdapterType.Portal,
      portalBridgeAddress: '0xF890982f9310df57d00f659cf4fd87e65adEd8d7',
      wormholeDomainMapping,
    },
    circle: {
      type: BridgeAdapterType.Circle,
      circleBridgeAddress: '0xdabec94b97f7b5fca28f050cc8eeac2dc9920476',
      messageTransmitterAddress: '0x40a61d3d2afcf5a5d31fcdf269e575fb99dd87f7',
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
      circleBridgeAddress: '0x0fc1103927af27af808d03135214718bcedbe9ad',
      messageTransmitterAddress: '0x52fffb3ee8fa7838e9858a2d5e454007b9027c3c',
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
