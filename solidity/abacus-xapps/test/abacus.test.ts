import { ethers, abacus } from 'hardhat';

describe.only('abacus', async () => {
  it('deploys', async () => {
    const domains = [1, 2, 3, 4, 5];
    const [signer] = await ethers.getSigners();
    const abacusDeployment = await abacus.AbacusDeployment.fromDomains(domains, signer);
  });
});
