import {
  BridgeAdapterConfig,
  BridgeAdapterType,
  ChainMap,
  Chains,
  RpcConsensusType,
  chainMetadata,
  getDomainId,
} from '@hyperlane-xyz/sdk';

import { LiquidityLayerRelayerConfig } from '../../../src/config/middleware.js';

import { environment } from './chains.js';

const circleDomainMapping = [
  {
    hyperlaneDomain: getDomainId(chainMetadata[Chains.ethereum]),
    circleDomain: 0,
  },
  {
    hyperlaneDomain: getDomainId(chainMetadata[Chains.avalanche]),
    circleDomain: 1,
  },
];

export const bridgeAdapterConfigs: ChainMap<BridgeAdapterConfig> = {
  [Chains.ethereum]: {
    circle: {
      type: BridgeAdapterType.Circle,
      tokenMessengerAddress: '0xBd3fa81B58Ba92a82136038B25aDec7066af3155',
      messageTransmitterAddress: '0x0a992d191DEeC32aFe36203Ad87D7d289a738F81',
      usdcAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      circleDomainMapping,
    },
  },
  [Chains.avalanche]: {
    circle: {
      type: BridgeAdapterType.Circle,
      tokenMessengerAddress: '0x6B25532e1060CE10cc3B0A99e5683b91BFDe6982',
      messageTransmitterAddress: '0x8186359af5f57fbb40c6b14a588d2a59c0c29880',
      usdcAddress: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      circleDomainMapping,
    },
  },
};

export const relayerConfig: LiquidityLayerRelayerConfig = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
    tag: '59410cd-20230420-091923',
  },
  namespace: environment,
  prometheusPushGateway:
    'http://prometheus-pushgateway.monitoring.svc.cluster.local:9091',
  connectionType: RpcConsensusType.Single,
};
