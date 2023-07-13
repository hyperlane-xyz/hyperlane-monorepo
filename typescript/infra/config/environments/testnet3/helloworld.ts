import { HelloWorldConfig as HWConfig } from '@hyperlane-xyz/helloworld';
import { AgentConnectionType, IsmConfig } from '@hyperlane-xyz/sdk';

import { HelloWorldConfig } from '../../../src/config';
import { HelloWorldKathyRunMode } from '../../../src/config/helloworld';
import { Contexts } from '../../contexts';

import { aggregationIsm } from './aggregationIsm';
import { environment } from './chains';
import hyperlaneAddresses from './helloworld/hyperlane/addresses.json';
import rcAddresses from './helloworld/rc/addresses.json';

export const hyperlane: HelloWorldConfig = {
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

export const releaseCandidate: HelloWorldConfig = {
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
  [Contexts.Hyperlane]: hyperlane,
  [Contexts.ReleaseCandidate]: releaseCandidate,
};

export const ism: IsmConfig = aggregationIsm(
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
);

// @hyperlane-xyz/helloworld HelloWorldConfig type
export const helloWorldConfig: HWConfig = {
  owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  mailbox: '0x4ed7c70F96B99c776995fB64377f0d4aB3B0e1C1',
  interchainGasPaymaster: '0x68B1D87F95878fE05B998F19b66F4baba5De1aed',
  interchainSecurityModule: ism,
};
