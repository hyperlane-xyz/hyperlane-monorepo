import { ethers } from 'ethers';

import { Mailbox, Mailbox__factory } from '@hyperlane-xyz/core';
import { types, utils } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../HyperlaneApp';
import { environments } from '../consts/environments';
import { buildContracts } from '../contracts';
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

export type CoreContractsMap = {
  [chain: ChainName]: CoreContracts;
};

export type DispatchedMessage = {
  id: string;
  message: string;
  parsed: types.ParsedMessage;
};

export class HyperlaneCore extends HyperlaneApp<CoreContracts> {
  constructor(contractsMap: CoreContractsMap, multiProvider: MultiProvider) {
    super(contractsMap, multiProvider);
  }

  static fromEnvironment<Env extends CoreEnvironment>(
    env: Env,
    multiProvider: MultiProvider,
  ): HyperlaneCore {
    const envConfig = environments[env];
    if (!envConfig) {
      throw new Error(`No default env config found for ${env}`);
    }

    const envChains = Object.keys(envConfig);

    const { intersection, multiProvider: intersectionProvider } =
      multiProvider.intersect(envChains, true);

    const intersectionConfig = pick(envConfig, intersection);
    const contractsMap = buildContracts(
      intersectionConfig,
      coreFactories,
    ) as CoreContractsMap;

    return new HyperlaneCore(contractsMap, intersectionProvider);
  }

  getContracts(chain: ChainName): CoreContracts {
    return super.getContracts(chain);
  }

  getConnectionClientConfig(chain: ChainName): ConnectionClientConfig {
    const contracts = this.getContracts(chain);
    return {
      mailbox: contracts.mailbox.address,
      // TODO allow these to be more easily changed
      interchainGasPaymaster:
        contracts.defaultIsmInterchainGasPaymaster.address,
    };
  }

  getConnectionClientConfigMap(): ChainMap<ConnectionClientConfig> {
    return objMap(this.contractsMap, (chain) =>
      this.getConnectionClientConfig(chain),
    );
  }

  extendWithConnectionClientConfig<T>(
    configMap: ChainMap<T>,
  ): ChainMap<T & ConnectionClientConfig> {
    const connectionClientConfigMap = this.getConnectionClientConfigMap();
    return objMap(configMap, (chain, config) => {
      return {
        ...config,
        ...connectionClientConfigMap[chain],
      };
    });
  }

  protected getDestination(message: DispatchedMessage): {
    destinationChain: ChainName;
    mailbox: Mailbox;
  } {
    const destinationChain = this.multiProvider.getChainName(
      message.parsed.destination,
    );
    const mailbox = this.getContracts(destinationChain).mailbox.contract;
    return { destinationChain, mailbox };
  }

  protected waitForProcessReceipt(
    message: DispatchedMessage,
  ): Promise<ethers.ContractReceipt> {
    const id = utils.messageId(message.message);
    const { destinationChain, mailbox } = this.getDestination(message);
    const filter = mailbox.filters.ProcessId(id);

    return new Promise<ethers.ContractReceipt>((resolve, reject) => {
      mailbox.once(filter, (emittedId, event) => {
        if (id !== emittedId) {
          reject(`Expected message id ${id} but got ${emittedId}`);
        }
        resolve(
          this.multiProvider.handleTx(destinationChain, event.getTransaction()),
        );
      });
    });
  }

  protected async waitForMessageWasProcessed(
    message: DispatchedMessage,
  ): Promise<void> {
    const id = utils.messageId(message.message);
    const { mailbox } = this.getDestination(message);
    await utils.pollAsync(async () => {
      const delivered = await mailbox.delivered(id);
      if (!delivered) {
        throw new Error(`Message ${id} not yet processed`);
      }
    });
    return;
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

  async waitForMessageProcessed(
    sourceTx: ethers.ContractReceipt,
  ): Promise<void> {
    const messages = this.getDispatchedMessages(sourceTx);
    await Promise.all(
      messages.map((msg) => this.waitForMessageWasProcessed(msg)),
    );
  }
}
