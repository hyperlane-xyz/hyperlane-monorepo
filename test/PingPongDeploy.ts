import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { types } from '@abacus-network/utils';
import { TestAbacusDeploy, TestRouterDeploy } from '@abacus-network/hardhat';

import { PingPong__factory, PingPong } from '../src/types';

// PingPong has no configurable variables.
export type PingPongConfig = {
  signer: SignerWithAddress;
};

export class PingPongDeploy extends TestRouterDeploy<PingPong, PingPongConfig> {
  async deployInstance(
    domain: types.Domain,
    abacus: TestAbacusDeploy,
  ): Promise<PingPong> {
    const pingPongFactory = new PingPong__factory(this.config.signer);
    const router = await pingPongFactory.deploy(
      abacus.xAppConnectionManager(domain).address,
    );
    await router.transferOwnership(this.config.signer.address);
    return router;
  }

  router(domain: types.Domain): PingPong {
    return this.instances[domain];
  }
}
