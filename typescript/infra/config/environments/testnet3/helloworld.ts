import { HelloWorldConfig as HelloWorldContractsConfig } from '@hyperlane-xyz/helloworld';
import {
  AgentConnectionType,
  ChainMap,
  RouterConfig,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { DeployEnvironment, HelloWorldConfig } from '../../../src/config';
import { HelloWorldKathyRunMode } from '../../../src/config/helloworld';
import { aggregationIsm } from '../../aggregationIsm';
import { Contexts } from '../../contexts';

import { environment } from './chains';
import hyperlaneAddresses from './helloworld/hyperlane/addresses.json';
import rcAddresses from './helloworld/rc/addresses.json';

export const hyperlaneHelloworld: HelloWorldConfig = {
  addresses: hyperlaneAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
      tag: '4c598b9-20230503-205323',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    runConfig: {
      mode: HelloWorldKathyRunMode.Service,
      fullCycleTime: 1000 * 60 * 60 * 24, // every 24 hours
    },
    messageSendTimeout: 1000 * 60 * 8, // 8 min
    messageReceiptTimeout: 1000 * 60 * 20, // 20 min
    connectionType: AgentConnectionType.HttpFallback,
  },
};

export const releaseCandidateHelloworld: HelloWorldConfig = {
  addresses: rcAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
      tag: '25f19b7-20230319-124624',
    },
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    runConfig: {
      mode: HelloWorldKathyRunMode.CycleOnce,
    },
    messageSendTimeout: 1000 * 60 * 8, // 8 min
    messageReceiptTimeout: 1000 * 60 * 20, // 20 min
    connectionType: AgentConnectionType.Http,
  },
};

export const helloWorld = {
  [Contexts.Hyperlane]: hyperlaneHelloworld,
  [Contexts.ReleaseCandidate]: releaseCandidateHelloworld,
};

export const helloWorldConfig = (
  environment: DeployEnvironment,
  context: Contexts,
  routerConfigMap: ChainMap<RouterConfig>,
): ChainMap<HelloWorldContractsConfig> =>
  objMap(routerConfigMap, (chain, routerConfig) => ({
    ...routerConfig,
    interchainSecurityModule: aggregationIsm(environment, chain, context),
  }));
