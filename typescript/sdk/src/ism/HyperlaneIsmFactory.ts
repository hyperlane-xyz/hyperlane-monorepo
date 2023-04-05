import { ethers } from 'ethers';

import { types } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../HyperlaneApp';
import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../consts/environments';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { IsmFactoryFactories, ismFactoryFactories } from './contracts';
import { IsmConfig, ModuleType } from './types';

export class HyperlaneIsmFactory extends HyperlaneApp<IsmFactoryFactories> {
  static fromEnvironment<Env extends HyperlaneEnvironment>(
    env: Env,
    multiProvider: MultiProvider,
  ): HyperlaneIsmFactory {
    const envAddresses = hyperlaneEnvironments[env];
    if (!envAddresses) {
      throw new Error(`No addresses found for ${env}`);
    }
    const fromAddressesMap = HyperlaneApp.fromAddressesMap(
      envAddresses,
      ismFactoryFactories,
      multiProvider,
    );
    return new HyperlaneIsmFactory(
      fromAddressesMap.contractsMap,
      fromAddressesMap.multiProvider,
    );
  }

  async deploy(chain: ChainName, config: IsmConfig): Promise<types.Address> {
    switch (config.type) {
      case ModuleType.MULTISIG: {
        const multisigIsmFactory = this.getContracts(chain).multisigIsmFactory;
        return this.deployMOfNFactory(
          chain,
          multisigIsmFactory,
          config.validators,
          config.threshold,
        );
        //statements;
      }
      case ModuleType.ROUTING: {
        const routingIsmFactory = this.getContracts(chain).routingIsmFactory;
        const isms: ChainMap<types.Address> = {};
        for (const origin of Object.keys(config.domains)) {
          isms[chain] = await this.deploy(chain, config.domains[origin]);
        }
        const domains = Object.keys(isms).map(this.multiProvider.getDomainId);
        const modules = Object.values(isms);
        const tx = await routingIsmFactory.deploy(domains, modules);
        const receipt = await this.multiProvider.handleTx(chain, tx);
        const dispatchLogs = receipt.logs
          .map((log) => {
            try {
              return routingIsmFactory.interface.parseLog(log);
            } catch (e) {
              return undefined;
            }
          })
          .filter(
            (log): log is ethers.utils.LogDescription =>
              !!log && log.name === 'ModuleDeployed',
          );
        return dispatchLogs[0].args['module'];
      }
      case ModuleType.AGGREGATION: {
        const aggregationIsmFactory =
          this.getContracts(chain).aggregationIsmFactory;
        const addresses: types.Address[] = [];
        for (const module of config.modules) {
          addresses.push(await this.deploy(chain, module));
        }
        return this.deployMOfNFactory(
          chain,
          aggregationIsmFactory,
          addresses,
          config.threshold,
        );
      }
      default: {
        throw new Error('Unknown ModuleType');
      }
    }
  }
  private async deployMOfNFactory(
    chain: ChainName,
    factory: StaticMOfNAddressSetFactory,
    values: types.Address[],
    threshold: number,
  ): Promise<types.Address> {
    const address = await factory.getAddress(values.sort(), threshold);
    const provider = this.multiProvider.getProvider(chain);
    const code = await provider.getCode(address);
    if (code === '0x') {
      await factory.deploy(values.sort(), threshold);
    }
    return address;
  }
}
