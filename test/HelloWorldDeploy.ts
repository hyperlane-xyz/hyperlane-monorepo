import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { types } from '@abacus-network/utils';
import { TestAbacusDeploy, TestRouterDeploy } from '@abacus-network/hardhat';

import { HelloWorld__factory, HelloWorld } from '../src/types';

// HelloWorld has no configurable variables.
export type HelloWorldConfig = {
  signer: SignerWithAddress;
};

export class HelloWorldDeploy extends TestRouterDeploy<
  HelloWorld,
  HelloWorldConfig
> {
  async deployInstance(
    domain: types.Domain,
    abacus: TestAbacusDeploy,
  ): Promise<HelloWorld> {
    const helloWorldFactory = new HelloWorld__factory(this.config.signer);
    const router = await helloWorldFactory.deploy();
    await router.initialize(abacus.abacusConnectionManager(domain).address);
    await router.transferOwnership(this.config.signer.address);
    return router;
  }

  router(domain: types.Domain): HelloWorld {
    return this.instances[domain];
  }
}
