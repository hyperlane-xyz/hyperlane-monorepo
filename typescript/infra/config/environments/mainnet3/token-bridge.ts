import {
  BridgeAdapterType,
  ChainMap,
  CircleBridgeAdapterConfig,
} from '@hyperlane-xyz/sdk';

import { getDomainId } from '../../registry.js';

const circleDomainMapping = [
  { hyperlaneDomain: getDomainId('fuji'), circleDomain: 1 },
];

// Circle deployed contracts
export const circleBridgeAdapterConfig: ChainMap<CircleBridgeAdapterConfig> = {
  fuji: {
    type: BridgeAdapterType.Circle,
    tokenMessengerAddress: '0x0fc1103927af27af808d03135214718bcedbe9ad',
    messageTransmitterAddress: '0x52fffb3ee8fa7838e9858a2d5e454007b9027c3c',
    usdcAddress: '0x5425890298aed601595a70ab815c96711a31bc65',
    circleDomainMapping,
  },
};
