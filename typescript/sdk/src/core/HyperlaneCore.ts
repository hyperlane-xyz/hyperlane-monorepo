import { ethers } from 'ethers';

import { Inbox, Outbox, Outbox__factory } from '@hyperlane-xyz/core';
import { types, utils } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../HyperlaneApp';
import { environments } from '../consts/environments';
import { buildContracts } from '../contracts';
import { DomainIdToChainName } from '../domains';
import { ChainConnection } from '../providers/ChainConnection';
import { MultiProvider } from '../providers/MultiProvider';
import { ConnectionClientConfig } from '../router';
import { ChainMap, ChainName, Remotes } from '../types';
import { objMap, pick } from '../utils/objects';

import { CoreContracts, coreFactories } from './contracts';

export type CoreEnvironment = keyof typeof environments;
export type CoreEnvironmentChain<E extends CoreEnvironment> = Extract<
  keyof typeof environments[E],
  ChainName
>;

export type CoreContractsMap<Chain extends ChainName> = {
  [local in Chain]: CoreContracts<Chain, local>;
};

export type DispatchedMessage = {
  leafIndex: number;
  message: string;
  parsed: types.ParsedMessage;
};

export class HyperlaneCore<
  Chain extends ChainName = ChainName,
> extends HyperlaneApp<CoreContracts<Chain, Chain>, Chain> {
  constructor(
    contractsMap: CoreContractsMap<Chain>,
    multiProvider: MultiProvider<Chain>,
  ) {
    super(contractsMap, multiProvider);
  }

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  static fromEnvironment<
    Env extends CoreEnvironment,
    Chain extends ChainName = ChainName,
  >(env: Env, multiProvider: MultiProvider<Chain>) {
    const envConfig = environments[env];
    if (!envConfig) {
      throw new Error(`No default env config found for ${env}`);
    }

    type EnvChain = keyof typeof envConfig;
    type IntersectionChain = EnvChain & Chain;
    const envChains = Object.keys(envConfig) as IntersectionChain[];

    const { intersection, multiProvider: intersectionProvider } =
      multiProvider.intersect<IntersectionChain>(envChains);

    const intersectionConfig = pick(
      envConfig as ChainMap<Chain, any>,
      intersection,
    );
    const contractsMap = buildContracts(
      intersectionConfig,
      coreFactories,
    ) as CoreContractsMap<IntersectionChain>;

    return new HyperlaneCore(contractsMap, intersectionProvider);
  }

  // override type to be derived from chain key
  getContracts<Local extends Chain>(chain: Local): CoreContracts<Chain, Local> {
    return super.getContracts(chain) as CoreContracts<Chain, Local>;
  }

  getConnectionClientConfig(chain: Chain): ConnectionClientConfig {
    const contracts = this.getContracts(chain);
    return {
      connectionManager: contracts.connectionManager.address,
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
  ): ChainMap<Chain, T & { connectionManager: string }> {
    return objMap(config, (chain, config) => ({
      ...config,
      connectionManager: this.getContracts(chain).connectionManager.address,
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
    const hash = utils.messageHash(message.message, message.leafIndex);
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
    const outbox = Outbox__factory.createInterface();
    const describedLogs = sourceTx.logs.map((log) => {
      try {
        return outbox.parseLog(log);
      } catch (e) {
        return undefined;
      }
    });
    const dispatchLogs = describedLogs.filter(
      (log) => log && log.name === 'Dispatch',
    ) as ethers.utils.LogDescription[];
    if (dispatchLogs.length === 0) {
      throw new Error('Dispatch logs not found');
    }
    return dispatchLogs.map((log) => {
      const message = log.args['message'];
      const parsed = utils.parseMessage(message);
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
