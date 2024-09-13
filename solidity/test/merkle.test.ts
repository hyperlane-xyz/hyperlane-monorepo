import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import { expect } from 'chai';
import { utils } from 'ethers';
import hre from 'hardhat';
import { Provider, Wallet } from 'zksync-ethers';

import merkleTestCases from '../../vectors/merkle.json' assert { type: 'json' };
import { TestMerkle, TestMerkle__factory } from '../types';

import { getSigner } from './signer';

describe('Merkle', async () => {
  for (const testCase of merkleTestCases) {
    const { testName, leaves, expectedRoot, proofs } = testCase;

    describe(testName, async () => {
      let merkle: any;

      before(async () => {
        // const signer = await getSigner();

        const provider = new Provider('http://127.0.0.1:8011');

        const deployerWallet = new Wallet(
          '0x3d3cbc973389cb26f657686445bcc75662b415b656078503592ac8c1abb8810e',
          provider,
        );
        const deployer = new Deployer(hre, deployerWallet);
        const artifact = await deployer.loadArtifact('TestMerkle');
        merkle = await deployer.deploy(artifact, []);

        //insert the leaves
        for (const leaf of leaves) {
          const leafHash = utils.hashMessage(leaf);
          await merkle.insert(leafHash);
        }
      });

      it('returns the correct leaf count', async () => {
        const leafCount = await merkle.count();
        expect(leafCount).to.equal(leaves.length);
      });

      it('produces the proper root', async () => {
        expect(await merkle.root()).to.equal(expectedRoot);
      });

      it("can verify the leaves' proofs", async () => {
        for (const proof of proofs) {
          const { leaf, path, index } = proof;

          const proofRoot = await merkle.branchRoot(leaf, path, index);
          expect(proofRoot).to.equal(expectedRoot);
        }
      });
    });
  }
});
