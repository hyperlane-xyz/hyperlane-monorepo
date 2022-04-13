import { TestAbacusDeploy, TestRouterDeploy } from '@abacus-network/hardhat';
import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';
import { AbcToken, AbcToken__factory } from '../types';

export type TokenConfig = {
  signer: ethers.Signer;
  name: string;
  symbol: string;
  totalSupply: ethers.BigNumberish;
};

export class TokenDeploy extends TestRouterDeploy<AbcToken, TokenConfig> {
  async deployInstance(
    domain: types.Domain,
    abacus: TestAbacusDeploy,
  ): Promise<AbcToken> {
    const tokenFactory = new AbcToken__factory(this.config.signer);
    const token = await tokenFactory.deploy();
    await token.initialize(
      abacus.xAppConnectionManager(domain).address,
      this.config.totalSupply,
      this.config.name,
      this.config.symbol,
    );
    return token;
  }

  router(domain: types.Domain): AbcToken {
    return this.instances[domain];
  }
}
