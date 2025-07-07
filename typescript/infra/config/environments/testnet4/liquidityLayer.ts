import {
  BridgeAdapterConfig,
  BridgeAdapterType,
  ChainMap,
} from '@hyperlane-xyz/sdk';

import { getDomainId } from '../../registry.js';

const circleDomainMapping = [
  { hyperlaneDomain: getDomainId('fuji'), circleDomain: 1 },
];

export const bridgeAdapterConfigs: ChainMap<BridgeAdapterConfig> = {
  fuji: {
    circle: {
      type: BridgeAdapterType.Circle,
      tokenMessengerAddress: '0xeb08f243e5d3fcff26a9e38ae5520a669f4019d0',
      messageTransmitterAddress: '0xa9fb1b3009dcb79e2fe346c16a604b8fa8ae0a79',
      usdcAddress: '0x5425890298aed601595a70ab815c96711a31bc65',
      circleDomainMapping,
    },
  },
};
