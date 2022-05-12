import { TestAbacusDeploy, TestRouterDeploy } from '@abacus-network/hardhat';
import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';
import { AbcERC20, AbcERC20__factory } from '../types';

export type TokenConfig = {
  signer: ethers.Signer;
  name: string;
  symbol: string;
  totalSupply: ethers.BigNumberish;
};

export class AbcERC20Deploy extends TestRouterDeploy<AbcERC20, TokenConfig> {
  async deployInstance(
    domain: types.Domain,
    abacus: TestAbacusDeploy,
  ): Promise<AbcERC20> {
    const tokenFactory = new AbcERC20__factory(this.config.signer);
    const token = await tokenFactory.deploy();
    await token.initialize(
      abacus.abacusConnectionManager(domain).address,
      this.config.totalSupply,
      this.config.name,
      this.config.symbol,
    );
    return token;
  }

  router(domain: types.Domain) {
    return this.instances[domain];
  }
}
