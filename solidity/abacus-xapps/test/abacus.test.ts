import { ethers, abacus } from 'hardhat';
import { BridgeDeployment } from './lib/BridgeDeployment';

describe('abacus', async () => {
  it('deploys', async () => {
    const domains = [1, 2, 3, 4, 5];
    const [signer] = await ethers.getSigners();
    const abacusDeployment = await abacus.deployment.fromDomains(
      domains,
      signer,
    );
    const bridgeDeployment = await BridgeDeployment.fromAbacusDeployment(
      abacusDeployment,
      signer,
    );
  });
});
