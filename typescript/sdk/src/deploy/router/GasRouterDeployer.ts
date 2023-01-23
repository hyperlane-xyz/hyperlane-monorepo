import { debug } from 'debug';
import { BigNumberish } from 'ethers';

import { GasRouter } from '@hyperlane-xyz/core';

import { chainMetadata } from '../../consts/chainMetadata';
import { DomainIdToChainName } from '../../domains';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterContracts, RouterFactories } from '../../router';
import { ChainMap, ChainName } from '../../types';
import { DeployerOptions } from '../HyperlaneDeployer';

import { HyperlaneRouterDeployer } from './HyperlaneRouterDeployer';
import { GasRouterConfig } from './types';

export abstract class GasRouterDeployer<
  Chain extends ChainName,
  Config extends GasRouterConfig,
  Contracts extends RouterContracts<GasRouter>,
  Factories extends RouterFactories<GasRouter>,
> extends HyperlaneRouterDeployer<Chain, Config, Contracts, Factories> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, Config>,
    factories: Factories,
    options?: DeployerOptions,
  ) {
    super(multiProvider, configMap, factories, {
      logger: debug('hyperlane:RouterDeployer'),
      ...options,
    });
  }

  async setGasOverhead(
    contractsMap: ChainMap<Chain, Contracts>,
  ): Promise<void> {
    this.logger(`Setting enrolled router handle gas overhead...`);
    for (const [chain, contracts] of Object.entries<Contracts>(contractsMap)) {
      const local = chain as Chain;
      const localConfig = this.configMap[local];

      const remoteDomains = await contracts.router.domains();
      const remoteChains = remoteDomains.map(
        (domain) => DomainIdToChainName[domain] as Chain,
      );

      let gasOverhead: BigNumberish[];

      if ('messageBody' in localConfig) {
        const localId = chainMetadata[local].id;
        gasOverhead = await Promise.all(
          remoteChains.map(async (remoteChain) =>
            contractsMap[remoteChain].router.estimateGas.handle(
              localId,
              contracts.router.address,
              localConfig.messageBody,
              { from: this.configMap[remoteChain].mailbox },
            ),
          ),
        );
      } else {
        gasOverhead = remoteChains.map((remoteChain) => {
          const remoteConfig = this.configMap[remoteChain];
          if ('gasOverhead' in remoteConfig) {
            return remoteConfig.gasOverhead;
          } else {
            throw new Error(`No gas overhead specified for ${remoteChain}`);
          }
        });
      }

      const chainConnection = this.multiProvider.getChainConnection(local);
      const configs = remoteDomains.map((domain, i) => ({
        domain,
        handleGasOverhead: gasOverhead[i],
      }));
      this.logger(
        `Enroll remote (${remoteChains}) handle gas overhead on ${local}`,
      );
      await chainConnection.handleTx(
        contracts.router.setGasOverheadConfigs(configs),
      );
    }
  }

  async deploy(
    partialDeployment?: Partial<Record<Chain, Contracts>>,
  ): Promise<ChainMap<Chain, Contracts>> {
    const contractsMap = await super.deploy(partialDeployment);

    await super.enrollRemoteRouters(contractsMap);
    await super.initConnectionClient(contractsMap);

    await this.setGasOverhead(contractsMap);

    await super.transferOwnership(contractsMap);

    return contractsMap;
  }
}
