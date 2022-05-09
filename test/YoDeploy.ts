import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { types } from '@abacus-network/utils';
import { TestAbacusDeploy, TestRouterDeploy } from '@abacus-network/hardhat';

import { Yo__factory, Yo } from '../src/types';

// Yo has no configurable variables.
export type YoConfig = {
  signer: SignerWithAddress;
};

export class YoDeploy extends TestRouterDeploy<Yo, YoConfig> {
  async deployInstance(
    domain: types.Domain,
    abacus: TestAbacusDeploy,
  ): Promise<Yo> {
    const yoFactory = new Yo__factory(this.config.signer);
    const router = await yoFactory.deploy();
    await router.initialize(abacus.abacusConnectionManager(domain).address);
    await router.transferOwnership(this.config.signer.address);
    return router;
  }

  router(domain: types.Domain): Yo {
    return this.instances[domain];
  }
}
