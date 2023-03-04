import { types } from '@hyperlane-xyz/utils';

import { ChainMap, ChainName } from '../types';

export type AgentSigner = {
  key: string;
  type: string; // TODO
};

export enum AgentConnectionType {
  Http = 'http',
  Ws = 'ws',
  HttpQuorum = 'httpQuorum',
  HttpFallback = 'httpFallback',
}

export type AgentConnection =
  | {
      type: AgentConnectionType.Http;
      url: string;
    }
  | { type: AgentConnectionType.Ws; url: string }
  | { type: AgentConnectionType.HttpQuorum; urls: string };

export type AgentAddresses = {
  mailbox: types.Address;
  interchainGasPaymaster: types.Address;
  validatorAnnounce: types.Address;
};

export type AgentChainSetup = {
  name: ChainName;
  domain: number;
  signer?: AgentSigner | null;
  finalityBlocks: number;
  addresses: AgentAddresses;
  protocol: 'ethereum' | 'fuel';
  connection: AgentConnection;
  index?: { from: number };
};

export type AgentConfig = {
  chains: Partial<ChainMap<AgentChainSetup>>;
  // TODO: Separate DBs for each chain (fold into AgentChainSetup)
  db: string;
  tracing: {
    level: string;
    fmt: 'json';
  };
};
