import { ethers } from 'ethers';

import { Inbox, Outbox } from '@abacus-network/core';
import { ParsedMessage } from '@abacus-network/utils/dist/src/types';
import {
  messageHash,
  parseMessage,
} from '@abacus-network/utils/dist/src/utils';

import { AbacusApp } from '../AbacusApp';
import { environments } from '../consts/environments';
import { buildContracts } from '../contracts';
import { DomainIdToChainName } from '../domains';
import { ChainConnection } from '../providers/ChainConnection';
import { MultiProvider } from '../providers/MultiProvider';
import { ConnectionClientConfig } from '../router';
import { ChainMap, ChainName, Remotes } from '../types';
import { objMap } from '../utils';

import { CoreContracts, coreFactories } from './contracts';

export type CoreEnvironment = keyof typeof environments;
export type CoreEnvironmentChain<E extends CoreEnvironment> = Extract<
  keyof typeof environments[E],
  ChainName
>;

export type CoreContractsMap<Chain extends ChainName> = {
  [local in Chain]: CoreContracts<Chain, local>;
};

type DispatchedMessage = {
  leafIndex: number;
  message: string;
  parsed: ParsedMessage;
};

export class AbacusCore<Chain extends ChainName = ChainName> extends AbacusApp<
  CoreContracts<Chain, Chain>,
  Chain
> {
  constructor(
    contractsMap: CoreContractsMap<Chain>,
    multiProvider: MultiProvider<Chain>,
  ) {
    super(contractsMap, multiProvider);
  }

  static fromEnvironment<Env extends CoreEnvironment>(
    env: Env,
    multiProvider: MultiProvider<CoreEnvironmentChain<Env>>,
  ): AbacusCore<CoreEnvironmentChain<Env>> {
    const contractsMap = buildContracts(
      environments[env],
      coreFactories,
    ) as CoreContractsMap<CoreEnvironmentChain<Env>>;
    return new AbacusCore(contractsMap, multiProvider);
  }

  // override type to be derived from chain key
  getContracts<Local extends Chain>(chain: Local): CoreContracts<Chain, Local> {
    return super.getContracts(chain) as CoreContracts<Chain, Local>;
  }

  getConnectionClientConfig(chain: Chain): ConnectionClientConfig {
    const contracts = this.getContracts(chain);
    return {
      abacusConnectionManager: contracts.abacusConnectionManager.address,
      interchainGasPaymaster: contracts.interchainGasPaymaster.address,
    };
  }

  getConnectionClientConfigMap(): ChainMap<Chain, ConnectionClientConfig> {
    return objMap(this.contractsMap, (chain) =>
      this.getConnectionClientConfig(chain),
    );
  }

  extendWithConnectionClientConfig<T>(
    configMap: ChainMap<Chain, T>,
  ): ChainMap<Chain, T & ConnectionClientConfig> {
    const connectionClientConfigMap = this.getConnectionClientConfigMap();
    return objMap(configMap, (chain, config) => {
      return {
        ...config,
        ...connectionClientConfigMap[chain],
      };
    });
  }

  // TODO: deprecate
  extendWithConnectionManagers<T>(
    config: ChainMap<Chain, T>,
  ): ChainMap<Chain, T & { abacusConnectionManager: string }> {
    return objMap(config, (chain, config) => ({
      ...config,
      abacusConnectionManager:
        this.getContracts(chain).abacusConnectionManager.address,
    }));
  }

  getMailboxPair<Local extends Chain>(
    origin: Remotes<Chain, Local>,
    destination: Local,
  ): { originOutbox: Outbox; destinationInbox: Inbox } {
    const originOutbox = this.getContracts(origin).outbox.contract;
    const destinationInbox =
      this.getContracts(destination).inboxes[origin].inbox.contract;
    return { originOutbox, destinationInbox };
  }

  protected getDestination(message: DispatchedMessage): {
    inbox: Inbox;
    chainConnection: ChainConnection;
  } {
    const sourceChain = DomainIdToChainName[message.parsed.origin] as Chain;
    const destinationChain = DomainIdToChainName[
      message.parsed.destination
    ] as Chain;
    const { destinationInbox } = this.getMailboxPair(
      sourceChain as Exclude<Chain, typeof destinationChain>,
      destinationChain,
    );
    const chainConnection =
      this.multiProvider.getChainConnection(destinationChain);
    return { inbox: destinationInbox, chainConnection };
  }

  protected waitForProcessReceipt(
    message: DispatchedMessage,
  ): Promise<ethers.ContractReceipt> {
    const hash = messageHash(message.message, message.leafIndex);
    const { inbox, chainConnection } = this.getDestination(message);
    const filter = inbox.filters.Process(hash);

    return new Promise<ethers.ContractReceipt>((resolve, reject) => {
      inbox.once(filter, (emittedHash, event) => {
        if (hash !== emittedHash) {
          reject(`Expected message hash ${hash} but got ${emittedHash}`);
        }
        resolve(chainConnection.handleTx(event.getTransaction()));
      });
    });
  }

  getDispatchedMessages(sourceTx: ethers.ContractReceipt): DispatchedMessage[] {
    const arbitraryChain = Object.keys(this.contractsMap)[0];
    const outbox = this.getContracts(arbitraryChain as Chain).outbox.contract
      .interface;
    const describedLogs = sourceTx.logs.map((log) => outbox.parseLog(log));
    const dispatchLogs = describedLogs.filter(
      (log) => log && log.name === 'Dispatch',
    );
    if (dispatchLogs.length === 0) {
      throw new Error('Dispatch logs not found');
    }
    return dispatchLogs.map((log) => {
      const message = log.args['message'];
      const parsed = parseMessage(message);
      return { leafIndex: log.args['leafIndex'], message, parsed };
    });
  }

  waitForMessageProcessing(
    sourceTx: ethers.ContractReceipt,
  ): Promise<ethers.ContractReceipt[]> {
    const messages = this.getDispatchedMessages(sourceTx);
    return Promise.all(messages.map((msg) => this.waitForProcessReceipt(msg)));
  }
}
