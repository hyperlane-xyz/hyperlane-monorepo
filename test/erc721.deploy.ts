import { TestAbacusDeploy, TestRouterDeploy } from '@abacus-network/hardhat';
import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';
import { AbcERC721, AbcERC721__factory } from '../types';

export type TokenConfig = {
  signer: ethers.Signer;
  name: string;
  symbol: string;
  mintAmount: ethers.BigNumberish;
};

type ConfigMap = {
  [domain: number]: TokenConfig;
};

export class AbcERC721Deploy extends TestRouterDeploy<AbcERC721, ConfigMap> {
  async deployInstance(
    domain: types.Domain,
    abacus: TestAbacusDeploy,
  ): Promise<AbcERC721> {
    const localConfig = this.config[domain];
    const tokenFactory = new AbcERC721__factory(localConfig.signer);
    const token = await tokenFactory.deploy();
    await token.initialize(
      abacus.abacusConnectionManager(domain).address,
      localConfig.mintAmount,
      localConfig.name,
      localConfig.symbol,
    );
    return token;
  }

  router(domain: types.Domain) {
    return this.instances[domain];
  }
}
