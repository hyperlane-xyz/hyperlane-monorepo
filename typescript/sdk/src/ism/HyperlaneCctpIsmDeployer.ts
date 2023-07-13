import debug from 'debug';

import { HyperlaneContracts, HyperlaneContractsMap } from '../contracts';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { CctpIsmFactories, cctpIsmFactories } from './contracts';

export type CctpIsmConfig = {
  messageTransmitter: string;
};

export class HyperlaneCctpIsmDeployer extends HyperlaneDeployer<
  CctpIsmConfig,
  CctpIsmFactories
> {
  constructor(multiProvider: MultiProvider) {
    super(multiProvider, cctpIsmFactories, {
      logger: debug('hyperlane:CctpIsmDeployer'),
    });
  }

  async deploy(
    config: ChainMap<CctpIsmConfig>,
  ): Promise<HyperlaneContractsMap<CctpIsmFactories>> {
    return super.deploy(config as ChainMap<CctpIsmConfig>);
  }

  async deployContracts(
    chain: ChainName,
    config: CctpIsmConfig,
  ): Promise<HyperlaneContracts<CctpIsmFactories>> {
    const cctpIsmFactory = await this.deployContract(chain, 'cctpIsm', [
      config.messageTransmitter,
    ]);
    return cctpIsmFactory;
  }
}
