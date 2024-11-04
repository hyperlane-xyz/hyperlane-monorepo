import { Account } from 'starknet';

import { rootLogger } from '@hyperlane-xyz/utils';

import { StarknetDeployer } from '../deploy/StarknetDeployer.js';

export class StarknetCoreModule {
  protected logger = rootLogger.child({ module: 'StarknetCoreModule' });
  protected deployer: StarknetDeployer;
  constructor(protected readonly signer: Account) {
    this.deployer = new StarknetDeployer(signer);
  }

  async deploy() {
    const NoopISM = await this.deployer.deployContract('noop_ism', []);
    return { NoopISM };
  }
}
