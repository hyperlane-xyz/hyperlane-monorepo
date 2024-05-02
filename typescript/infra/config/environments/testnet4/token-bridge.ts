import {
  BridgeAdapterConfig,
  BridgeAdapterType,
  ChainMap,
} from '@hyperlane-xyz/sdk';

import { getDomainId } from '../../registry.js';

const circleDomainMapping = [
  { hyperlaneDomain: getDomainId('fuji'), circleDomain: 1 },
];

const wormholeDomainMapping = [
  {
    hyperlaneDomain: getDomainId('fuji'),
    wormholeDomain: 6,
  },
  {
    hyperlaneDomain: getDomainId('bsctestnet'),
    wormholeDomain: 4,
  },
  {
    hyperlaneDomain: getDomainId('alfajores'),
    wormholeDomain: 14,
  },
];

export const bridgeAdapterConfigs: ChainMap<BridgeAdapterConfig> = {
  fuji: {
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
  bsctestnet: {
    portal: {
      type: BridgeAdapterType.Portal,
      portalBridgeAddress: '0x9dcF9D205C9De35334D646BeE44b2D2859712A09',
      wormholeDomainMapping,
    },
  },
  alfajores: {
    portal: {
      type: BridgeAdapterType.Portal,
      portalBridgeAddress: '0x05ca6037eC51F8b712eD2E6Fa72219FEaE74E153',
      wormholeDomainMapping,
    },
  },
};
