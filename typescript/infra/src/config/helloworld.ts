import { ChainMap, ChainName } from '@abacus-network/sdk';

import { DockerConfig } from './agent';

export interface HelloWorldKathyConfig<Chain extends ChainName> {
  docker: DockerConfig;
  chains: Chain[];
  runEnv: string;
  namespace: string;
}

export interface HelloWorldConfig<Chain extends ChainName> {
  addresses: ChainMap<Chain, { router: string }>;
  kathy: HelloWorldKathyConfig<Chain>;
}
