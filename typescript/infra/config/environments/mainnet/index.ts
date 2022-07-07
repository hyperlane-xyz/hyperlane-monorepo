import { JsonRpcProvider } from '@ethersproject/providers';

import { getMultiProviderFromConfigAndSigner } from '@abacus-network/sdk';

import { getMultiProviderFromGCP } from '../../../scripts/utils';
import { CoreEnvironmentConfig } from '../../../src/config';
import { testConfigs } from '../test/chains';

import { agent } from './agent';
import {
  MainnetChains,
  environment as environmentName,
  mainnetConfigs,
} from './chains';
import { core } from './core';
import { relayerFunderConfig } from './funding';
import { helloWorld } from './helloworld';
import { infrastructure } from './infrastructure';

export const environment: CoreEnvironmentConfig<MainnetChains> = {
  environment: environmentName,
  transactionConfigs: mainnetConfigs,
  getMultiProvider: async () => {
    // simulate mainnet against test rpc
    const provider = testConfigs.test1.provider! as JsonRpcProvider;
    const signer = provider.getSigner(0);
    return getMultiProviderFromConfigAndSigner(mainnetConfigs, signer);
    return getMultiProviderFromGCP(mainnetConfigs, environmentName);
  },
  agent,
  core,
  infra: infrastructure,
  helloWorld,
  relayerFunderConfig,
};
