import { Inbox, Outbox } from '@abacus-network/core';

import { AbacusApp } from '../AbacusApp';
import { environments } from '../consts/environments';
import { buildContracts } from '../contracts';
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

export class AbacusCore<Chain extends ChainName = ChainName> extends AbacusApp<
  CoreContracts<Chain, Chain>,
  Chain
> {
  constructor(
    contractsMap: CoreContractsMap<Chain>,
    multiProvider: MultiProvider,
  ) {
    super(contractsMap, multiProvider);
  }

  static fromEnvironment<Env extends CoreEnvironment>(
    env: Env,
    multiProvider: MultiProvider,
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
}
