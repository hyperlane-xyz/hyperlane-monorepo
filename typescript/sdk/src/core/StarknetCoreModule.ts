import { Account } from 'starknet';

import { rootLogger } from '@hyperlane-xyz/utils';

import { StarknetDeployer } from '../deploy/StarknetDeployer.js';
import { ChainNameOrId } from '../types.js';

import { CoreConfig } from './types.js';

export class StarknetCoreModule {
  protected logger = rootLogger.child({ module: 'StarknetCoreModule' });
  protected deployer: StarknetDeployer;
  constructor(protected readonly signer: Account) {
    this.deployer = new StarknetDeployer(signer);
  }

  async deploy(params: {
    config: CoreConfig;
    chain: ChainNameOrId;
  }): Promise<{ mailbox: string; ism: string }> {
    const { config, chain } = params;

    const ism = await this.deployer.deployIsm({
      chain: chain.toString(),
      ismConfig: config.defaultIsm,
      mailbox: '',
    });
    return {
      mailbox: '',
      ism,
    };
  }
}
