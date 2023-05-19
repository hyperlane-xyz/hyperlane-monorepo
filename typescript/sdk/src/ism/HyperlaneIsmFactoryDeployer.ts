import debug from 'debug';

import { HyperlaneContracts, HyperlaneContractsMap } from '../contracts';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';
import { isObject } from '../utils/objects';

import { IsmFactoryFactories, ismFactoryFactories } from './contracts';

export class HyperlaneIsmFactoryDeployer extends HyperlaneDeployer<
  boolean,
  IsmFactoryFactories
> {
  constructor(multiProvider: MultiProvider) {
    super(multiProvider, ismFactoryFactories, {
      logger: debug('hyperlane:IsmFactoryDeployer'),
    });
  }

  async deploy(
    config: ChainName[] | ChainMap<boolean>,
  ): Promise<HyperlaneContractsMap<IsmFactoryFactories>> {
    if (isObject(config)) {
      return super.deploy(config as ChainMap<boolean>);
    } else {
      return super.deploy(
        Object.fromEntries((config as ChainName[]).map((c) => [c, true])),
      );
    }
  }

  async deployContracts(
    chain: ChainName,
  ): Promise<HyperlaneContracts<IsmFactoryFactories>> {
    const merkleRootMultisigIsm = await this.deployContract(
      chain,
      'merkleRootMultisigIsm',
      [],
    );
    const messageIdMultisigIsm = await this.deployContract(
      chain,
      'messageIdMultisigIsm',
      [],
    );
    const legacyMultisigIsm = await this.deployContract(
      chain,
      'legacyMultisigIsm',
      [],
    );
    const aggregationIsm = await this.deployContract(
      chain,
      'aggregationIsm',
      [],
    );
    const routingIsm = await this.deployContract(chain, 'routingIsm', []);
    return {
      legacyMultisigIsm,
      merkleRootMultisigIsm,
      messageIdMultisigIsm,
      aggregationIsm,
      routingIsm,
    };
  }
}
