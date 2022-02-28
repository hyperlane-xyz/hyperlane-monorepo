import { ethers } from 'hardhat';
import { expect } from 'chai';
import { Signer } from 'ethers';

import { getTestDeploy } from './testChain';
import { CoreContractAddresses } from '../src/config/addresses';
import { deployBridges } from '../src/bridge';
import { BridgeDeploy } from '../src/bridge/BridgeDeploy';
import {
  deployTwoChains,
  deployNChains,
} from '../src/core';
import { CoreDeploy } from '../src/core/CoreDeploy';
import { DeployEnvironment } from '../src/deploy';
import {
  MockWeth,
  MockWeth__factory,
} from '@abacus-network/ts-interface/dist/abacus-xapps';

const domains = [1000, 2000, 3000, 4000];

/*
 * Deploy the full Abacus suite on two chains
 */
describe('core deploy scripts', async () => {
  let signer: Signer, recoveryManager: Signer

  before(async () => {
    [signer, recoveryManager] = await ethers.getSigners();
  });

  describe('deployTwoChains', async () => {
    it('2-chain deploy', async () => {
      let deploys: CoreDeploy[] = [];
      for (var i = 0; i < 2; i++) {
        deploys.push(
          await getTestDeploy(domains[i], await signer.getAddress(), [
            await recoveryManager.getAddress(),
          ]),
        );
      }

      // deploy abacus contracts on 2 chains
      // will test inside deploy function
      await deployTwoChains(deploys[0], deploys[1]);
    });
  });

  describe('deployNChains', async () => {
    // tests deploys for up to 4 chains
    for (let i = 1; i <= 4; i++) {
      it(`${i}-chain deploy`, async () => {
        let deploys: CoreDeploy[] = [];
        for (let j = 0; j < i; j++) {
          deploys.push(
            await getTestDeploy(domains[j], await signer.getAddress(), [
              await recoveryManager.getAddress(),
            ]),
          );
        }

        // deploy abacus contracts on `i` chains
        // will test inside deploy function
        await deployNChains(deploys);
      });
    }

    it(`asserts there is at least one deploy config`, async () => {
      const deploys: CoreDeploy[] = [];
      const errMsg = 'Must pass at least one deploy config';

      try {
        await deployNChains(deploys);
        // `deployNChains` should error and skip to catch block. If it didn't, we need to make it fail
        // here (same as `expect(true).to.be.false`, but more explicit)
        expect('no error').to.equal(errMsg);
      } catch (e: any) {
        // expect correct error message
        expect(e.message).to.equal(errMsg);
      }
    });
  });
});

describe('bridge deploy scripts', async () => {
  const numChains = 3;

  let signer: Signer,
    recoveryManager: Signer,
    mockWeth: MockWeth,
    deploys: CoreDeploy[] = [],
    coreAddresses: CoreContractAddresses[] = [];

  before(async () => {
    [signer, recoveryManager] = await ethers.getSigners();
    mockWeth = await new MockWeth__factory(signer).deploy();

    // deploy core contracts on 2 chains
    for (let i = 0; i < numChains; i++) {
      if (i == 0) {
        deploys.push(
          await getTestDeploy(domains[i], await signer.getAddress(), [
            await recoveryManager.getAddress(),
          ]),
        );
      } else {
        deploys.push(
          await getTestDeploy(
            domains[i],
            await signer.getAddress(),
            [await recoveryManager.getAddress()],
            await recoveryManager.getAddress(),
            mockWeth.address,
          ),
        );
      }
    }
    await deployNChains(deploys);

    for (let i = 0; i < numChains; i++) {
      coreAddresses.push(deploys[i].contracts.toObject());
    }
  });

  it('2-chain bridge', async () => {
    // instantiate alfajores and kovan bridge deploys
    const alfajoresDeploy = new BridgeDeploy(
      deploys[0].chain,
      DeployEnvironment.test,
      true,
      coreAddresses[0],
    );
    const kovanDeploy = new BridgeDeploy(
      deploys[1].chain,
      DeployEnvironment.test,
      true,
      coreAddresses[1],
    );

    // deploy bridges
    await deployBridges([alfajoresDeploy, kovanDeploy]);
  });

  it('3-chain bridge', async () => {
    // instantiate 3 deploys: alfajores, kovan and rinkeby
    const alfajoresDeploy = new BridgeDeploy(
      deploys[0].chain,
      DeployEnvironment.test,
      true,
      coreAddresses[0],
    );
    const kovanDeploy = new BridgeDeploy(
      deploys[1].chain,
      DeployEnvironment.test,
      true,
      coreAddresses[1],
    );
    const rinkebyDeploy = new BridgeDeploy(
      deploys[2].chain,
      DeployEnvironment.test,
      true,
      coreAddresses[2],
    );

    // deploy 3 bridges
    await deployBridges([alfajoresDeploy, kovanDeploy, rinkebyDeploy]);
  });
});
