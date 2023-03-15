import { types } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../consts/chainMetadata';
import { MultiProvider } from '../providers/MultiProvider';
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

export type AgentContractAddresses = {
  mailbox: types.Address;
  interchainGasPaymaster: types.Address;
  validatorAnnounce: types.Address;
};

export type AgentChainSetup = {
  name: ChainName;
  domain: number;
  signer?: AgentSigner | null;
  finalityBlocks: number;
  addresses: AgentContractAddresses;
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

export async function buildAgentConfig(
  addresses: ChainMap<AgentContractAddresses>,
  multiProvider: MultiProvider,
) {
  const agentConfig: AgentConfig = {
    chains: {},
    db: 'db_path',
    tracing: {
      level: 'debug',
      fmt: 'json',
    },
  };

  const chains = Object.keys(addresses).sort();
  for (const chain of chains) {
    const metadata = chainMetadata[chain];
    const chainConfig: AgentChainSetup = {
      name: chain,
      domain: metadata.chainId,
      addresses: {
        mailbox: addresses[chain].mailbox,
        interchainGasPaymaster: addresses[chain].interchainGasPaymaster,
        validatorAnnounce: addresses[chain].validatorAnnounce,
      },
      signer: null,
      protocol: 'ethereum',
      finalityBlocks: metadata.blocks!.reorgPeriod!,
      connection: {
        type: AgentConnectionType.Http,
        url: '',
      },
    };

    chainConfig.index = {
      from: await multiProvider.getProvider(chain).getBlockNumber(),
    };

    agentConfig.chains[chain] = chainConfig;
  }
  return agentConfig;
}
