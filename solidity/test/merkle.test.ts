import { expect } from 'chai';
import hre from 'hardhat';
import { hashMessage } from 'viem';

import merkleTestCases from '../../vectors/merkle.json' with { type: 'json' };

describe('Merkle', async () => {
  for (const testCase of merkleTestCases) {
    const { testName, leaves, expectedRoot, proofs } = testCase;

    describe(testName, async () => {
      let merkle: any;
      let publicClient: any;

      before(async () => {
        publicClient = await hre.viem.getPublicClient();
        merkle = await hre.viem.deployContract('TestMerkle');

        //insert the leaves
        for (const leaf of leaves) {
          const leafHash = hashMessage(leaf);
          const tx = await merkle.write.insert([leafHash]);
          await publicClient.waitForTransactionReceipt({ hash: tx });
        }
      });

      it('returns the correct leaf count', async () => {
        expect(await merkle.read.count()).to.equal(BigInt(leaves.length));
      });

      it('produces the proper root', async () => {
        expect(await merkle.read.root()).to.equal(expectedRoot);
      });

      it("can verify the leaves' proofs", async () => {
        for (const proof of proofs) {
          const { leaf, path, index } = proof;

          const proofRoot = await merkle.read.branchRoot([leaf, path, index]);
          expect(proofRoot).to.equal(expectedRoot);
        }
      });
    });
  }
});
