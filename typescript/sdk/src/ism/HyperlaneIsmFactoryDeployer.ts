import debug from 'debug';

import { HyperlaneContracts, HyperlaneContractsMap } from '../contracts';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';

import { IsmFactoryFactories, ismFactoryFactories } from './contracts';

export class HyperlaneIsmFactoryDeployer extends HyperlaneDeployer<
  any,
  IsmFactoryFactories
> {
  constructor(multiProvider: MultiProvider) {
    super(multiProvider, ismFactoryFactories, {
      logger: debug('hyperlane:IsmFactoryDeployer'),
    });
  }

  async deploy(): Promise<HyperlaneContractsMap<IsmFactoryFactories>> {
    return super.deploy({});
  }
  async deployContracts(
    chain: ChainName,
  ): Promise<HyperlaneContracts<IsmFactoryFactories>> {
    const multisigIsmFactory = await this.deployContract(
      chain,
      'multisigIsmFactory',
      [],
    );
    const aggregationIsmFactory = await this.deployContract(
      chain,
      'aggregationIsmFactory',
      [],
    );
    const routingIsmFactory = await this.deployContract(
      chain,
      'routingIsmFactory',
      [],
    );
    return { multisigIsmFactory, aggregationIsmFactory, routingIsmFactory };
  }
}
