import { expect } from 'chai';
import { Wallet, utils } from 'ethers';

import { BaseValidator, type Checkpoint } from '@hyperlane-xyz/utils';

// Round-trip: signing with the same digest the on-chain ISM verifies should
// recover the validator address.
describe('checkpoint digest signing', () => {
  it('round-trips through BaseValidator.recoverAddressFromCheckpoint', async () => {
    const wallet = Wallet.createRandom();
    const merkleTreeHook = Wallet.createRandom().address;
    const checkpoint: Checkpoint = {
      root: utils.hexlify(utils.randomBytes(32)),
      index: 42,
      mailbox_domain: 1,
      merkle_tree_hook_address: utils.hexZeroPad(merkleTreeHook, 32),
    };
    const messageId = utils.hexlify(utils.randomBytes(32));

    const digest = BaseValidator.messageHash(checkpoint, messageId);
    const sig = await wallet.signMessage(digest);

    const recovered = BaseValidator.recoverAddressFromCheckpoint(
      checkpoint,
      sig,
      messageId,
    );
    expect(utils.getAddress(recovered)).to.equal(
      utils.getAddress(wallet.address),
    );
  });
});
