import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

import { ConnectionType, DockerConfig } from './agent';

export enum HelloWorldKathyRunMode {
  // Sends messages between all pairwise chains
  CycleOnce,
  // Long-running service, sending messages according to a full cycle time
  Service,
}

export interface HelloWorldKathyConfig<Chain extends ChainName> {
  docker: DockerConfig;
  runEnv: string;
  namespace: string;
  chainsToSkip: Chain[];
  runConfig:
    | {
        mode: HelloWorldKathyRunMode.CycleOnce;
      }
    | {
        mode: HelloWorldKathyRunMode.Service;
        /** How long kathy should take to send a message to all chain pairs before looping (milliseconds) */
        fullCycleTime: number;
      };
  /** How long kathy should wait before declaring an attempted to send a failure (milliseconds). */
  messageSendTimeout: number;
  /** How long kathy should wait before giving up on waiting for the message to be received (milliseconds). */
  messageReceiptTimeout: number;

  // Which type of provider to use
  connectionType: Exclude<ConnectionType, ConnectionType.Ws>;
  // How many cycles to skip between a cycles that send messages to/from Ethereum. Defaults to 0.
  cyclesBetweenEthereumMessages?: number;
}

export interface HelloWorldConfig<Chain extends ChainName> {
  addresses: ChainMap<Chain, { router: string }>;
  kathy: HelloWorldKathyConfig<Chain>;
}
