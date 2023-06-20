import { types } from '@hyperlane-xyz/utils';

import { ProtocolType } from '../consts/chainMetadata';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

export interface AgentSigner {
  key: string;
  type: string; // TODO
}

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
  | { type: AgentConnectionType.HttpQuorum; urls: string }
  | { type: AgentConnectionType.HttpFallback; urls: string };

export interface HyperlaneAgentAddresses {
  mailbox: types.Address;
  interchainGasPaymaster: types.Address;
  validatorAnnounce: types.Address;
}

export interface AgentChainSetupBase {
  name: ChainName;
  domain: number;
  signer?: AgentSigner;
  finalityBlocks: number;
  addresses: HyperlaneAgentAddresses;
  protocol: ProtocolType;
  connection?: AgentConnection;
  index?: { from: number };
}

export interface AgentChainSetup extends AgentChainSetupBase {
  signer: AgentSigner;
  connection: AgentConnection;
}

export interface AgentConfig {
  chains: Partial<ChainMap<AgentChainSetupBase>>;
  tracing?: {
    level?: string;
    fmt?: 'json';
  };
}

export function buildAgentConfig(
  chains: ChainName[],
  multiProvider: MultiProvider,
  addresses: ChainMap<HyperlaneAgentAddresses>,
  startBlocks: ChainMap<number>,
): AgentConfig {
  const agentConfig: AgentConfig = {
    chains: {},
  };

  for (const chain of [...chains].sort()) {
    const metadata = multiProvider.getChainMetadata(chain);
    const chainConfig: AgentChainSetupBase = {
      name: chain,
      domain: metadata.chainId,
      addresses: {
        mailbox: addresses[chain].mailbox,
        interchainGasPaymaster: addresses[chain].interchainGasPaymaster,
        validatorAnnounce: addresses[chain].validatorAnnounce,
      },
      protocol: metadata.protocol,
      finalityBlocks: metadata.blocks?.reorgPeriod ?? 1,
    };

    chainConfig.index = {
      from: startBlocks[chain],
    };

    agentConfig.chains[chain] = chainConfig;
  }
  return agentConfig;
}
