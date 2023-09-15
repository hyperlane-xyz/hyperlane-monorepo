import { expect } from 'chai';
import { keccak256 } from 'ethers/lib/utils';
import { ethers } from 'hardhat';

import { addressToBytes32 } from '@hyperlane-xyz/utils/dist/src/utils';

import merkleTestCases from '../../vectors/merkle.json';
import {
  TestMailbox,
  TestMailbox__factory,
  TestMerkleTreeHook,
  TestMerkleTreeHook__factory,
} from '../types';

describe('Merkle', async () => {
  for (const testCase of merkleTestCases) {
    const { testName, leaves, expectedRoot, proofs } = testCase;

    describe(testName, async () => {
      let merkle: TestMerkleTreeHook;
      let mailboxFactory: TestMailbox;

      before(async () => {
        const [signer] = await ethers.getSigners();
        mailboxFactory = await new TestMailbox__factory(signer).deploy(1);

        const merkleFactory = new TestMerkleTreeHook__factory(signer);
        merkle = await merkleFactory.deploy(mailboxFactory.address);

        //insert the leaves
        for (const leaf of leaves) {
          const leafHash = ethers.utils.hashMessage(leaf);
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

      it("emit 'InsertedIntoTree' events on postDispatch", async () => {
        const [signer] = await ethers.getSigners();
        const message = await mailboxFactory.buildOutboundMessage(
          1,
          addressToBytes32(signer.address),
          '0x',
        );
        const messageId = await keccak256(message);
        await mailboxFactory.updateLatestDispatchedId(messageId);
        await expect(merkle.postDispatch('0x', message, { value: 0 })).to.emit(
          merkle,
          'InsertedIntoTree',
        );
      });
    });
  }
});
