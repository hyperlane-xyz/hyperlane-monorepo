import { ChainMap, ChainName } from '@abacus-network/sdk';

import { DockerConfig } from './agent';

export interface HelloWorldKathyConfig<Chain extends ChainName> {
  docker: DockerConfig;
  runEnv: string;
  namespace: string;
  chainsToSkip: Chain[];
  /** How long kathy should take to send a message to all chain pairs before looping (milliseconds) */
  fullCycleTime: number;
}

export interface HelloWorldConfig<Chain extends ChainName> {
  addresses: ChainMap<Chain, { router: string }>;
  kathy: HelloWorldKathyConfig<Chain>;
}
