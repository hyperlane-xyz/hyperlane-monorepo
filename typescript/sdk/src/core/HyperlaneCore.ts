import { ethers } from 'ethers';

import { Mailbox, Mailbox__factory } from '@hyperlane-xyz/core';
import { types, utils } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../HyperlaneApp';
import { environments } from '../consts/environments';
import { buildContracts } from '../contracts';
import { DomainIdToChainName } from '../domains';
import { ChainConnection } from '../providers/ChainConnection';
import { MultiProvider } from '../providers/MultiProvider';
import { ConnectionClientConfig } from '../router';
import { ChainMap, ChainName } from '../types';
import { objMap, pick } from '../utils/objects';

import { CoreContracts, coreFactories } from './contracts';

export type CoreEnvironment = keyof typeof environments;
export type CoreEnvironmentChain<E extends CoreEnvironment> = Extract<
  keyof typeof environments[E],
  ChainName
>;

export type CoreContractsMap<Chain extends ChainName> = {
  [local in Chain]: CoreContracts;
};

export type DispatchedMessage = {
  id: string;
  message: string;
  parsed: types.ParsedMessage;
};

export class HyperlaneCore<
  Chain extends ChainName = ChainName,
> extends HyperlaneApp<CoreContracts, Chain> {
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
  getContracts<Local extends Chain>(chain: Local): CoreContracts {
    return super.getContracts(chain);
  }

  getConnectionClientConfig(chain: Chain): ConnectionClientConfig {
    const contracts = this.getContracts(chain);
    return {
      mailbox: contracts.mailbox.address,
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

  protected getDestination(message: DispatchedMessage): {
    mailbox: Mailbox;
    chainConnection: ChainConnection;
  } {
    const destinationChain = DomainIdToChainName[
      message.parsed.destination
    ] as Chain;
    const mailbox = this.getContracts(destinationChain).mailbox.contract;
    const chainConnection =
      this.multiProvider.getChainConnection(destinationChain);
    return { mailbox, chainConnection };
  }

  protected waitForProcessReceipt(
    message: DispatchedMessage,
  ): Promise<ethers.ContractReceipt> {
    const id = utils.messageId(message.message);
    const { mailbox, chainConnection } = this.getDestination(message);
    const filter = mailbox.filters.Process(id);

    return new Promise<ethers.ContractReceipt>((resolve, reject) => {
      mailbox.once(filter, (emittedId, event) => {
        if (id !== emittedId) {
          reject(`Expected message id ${id} but got ${emittedId}`);
        }
        // @ts-ignore
        resolve(chainConnection.handleTx(event.getTransaction()));
      });
    });
  }

  getDispatchedMessages(sourceTx: ethers.ContractReceipt): DispatchedMessage[] {
    const mailbox = Mailbox__factory.createInterface();
    const dispatchLogs = sourceTx.logs
      .map((log) => {
        try {
          return mailbox.parseLog(log);
        } catch (e) {
          return undefined;
        }
      })
      .filter(
        (log): log is ethers.utils.LogDescription =>
          !!log && log.name === 'Dispatch',
      );
    return dispatchLogs.map((log) => {
      const message = log.args['message'];
      const id = log.args['messageId'];
      const parsed = utils.parseMessage(message);
      return { id, message, parsed };
    });
  }

  waitForMessageProcessing(
    sourceTx: ethers.ContractReceipt,
  ): Promise<ethers.ContractReceipt[]> {
    const messages = this.getDispatchedMessages(sourceTx);
    return Promise.all(messages.map((msg) => this.waitForProcessReceipt(msg)));
  }
}
