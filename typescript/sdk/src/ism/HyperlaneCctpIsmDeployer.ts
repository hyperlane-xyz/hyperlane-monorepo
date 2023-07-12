import debug from 'debug';

import { HyperlaneContracts, HyperlaneContractsMap } from '../contracts';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';
import { isObject } from '../utils/objects';

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
    config: ChainName[] | ChainMap<CctpIsmConfig>,
  ): Promise<HyperlaneContractsMap<CctpIsmFactories>> {
    if (isObject(config)) {
      return super.deploy(config as ChainMap<CctpIsmConfig>);
    } else {
      return super.deploy(
        Object.fromEntries((config as ChainName[]).map((c) => [c, true])),
      );
    }
  }

  async deployContracts(
    chain: ChainName,
    config: CctpIsmConfig,
  ): Promise<HyperlaneContracts<CctpIsmFactories>> {
    const cctpIsmFactory = await this.deployContract(chain, 'cctpIsm', [
      '0x...CCTP_ADDRESS',
    ]);
    return {
      cctpIsmFactory,
    };
  }
}
