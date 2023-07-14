import { HelloWorldConfig as HelloWorldContractsConfig } from '@hyperlane-xyz/helloworld';
import {
  AgentConnectionType,
  ChainMap,
  RouterConfig,
  objMap,
} from '@hyperlane-xyz/sdk';

import { HelloWorldConfig } from '../../../src/config';
import { HelloWorldKathyRunMode } from '../../../src/config/helloworld';
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

const hyperlaneIsms = {
  alfajores: '0x213d837ABd4bBa0B59d09D358b72D917c851535C',
  fuji: '0xD2b5F736438128AAfFf1a8dc001339E554Fab5F4',
  mumbai: '0xe6Cd8A5135E2d709654a130da8ABe723608E72D7',
  bsctestnet: '0x0468C93F394660Ca543E3E21Cb99bB006Ad1764B',
  goerli: '0xc82aaE551c26055fE961cAC714012e917036321b',
  moonbasealpha: '0x3D390BD986cD7876eee62A8A9c67a023e114040f',
  optimismgoerli: '0x7241A2dEbE440b5dbAd4493c903e3Be08d7A468F',
  arbitrumgoerli: '0xac100574Eae6bcCb62CAFbadFAD401c92538d35c',
  sepolia: '0x55CF027D9f53D7E2567839a5691225024f424530',
};

export const helloWorldConfig = (
  context: Contexts,
  routerConfigMap: ChainMap<RouterConfig>,
): ChainMap<HelloWorldContractsConfig> =>
  objMap(routerConfigMap, (chain, routerConfig) => ({
    ...routerConfig,
    // @ts-ignore
    interchainSecurityModule: hyperlaneIsms[chain],
    // ...aggregationIsm(chain, context),
  }));
