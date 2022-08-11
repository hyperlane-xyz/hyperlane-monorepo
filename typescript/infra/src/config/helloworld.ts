import { ChainMap, ChainName } from '@abacus-network/sdk';

import { DockerConfig } from './agent';

export interface HelloWorldKathyConfig<Chain extends ChainName> {
  docker: DockerConfig;
  runEnv: string;
  namespace: string;
  chainsToSkip: Chain[];
  /** Whether to cycle once through all pairwise chains, or run kathy as a forever running service */
  cycleOnce: boolean;
  /** How long kathy should take to send a message to all chain pairs before looping (milliseconds) */
  fullCycleTime?: number;
  /** How long kathy should wait before declaring an attempted to send a failure (milliseconds). */
  messageSendTimeout?: number;
  /** How long kathy should wait before giving up on waiting for the message to be received (milliseconds). */
  messageReceiptTimeout?: number;
}

export interface HelloWorldConfig<Chain extends ChainName> {
  addresses: ChainMap<Chain, { router: string }>;
  kathy: HelloWorldKathyConfig<Chain>;
}
