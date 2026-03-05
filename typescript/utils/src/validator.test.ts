import { expect } from 'chai';
import { Hex, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { Checkpoint } from './types.js';
import { BaseValidator } from './validator.js';

function signatureToRSV(signature: Hex): { r: Hex; s: Hex; v: number } {
  return {
    r: `0x${signature.slice(2, 66)}` as Hex,
    s: `0x${signature.slice(66, 130)}` as Hex,
    v: Number.parseInt(signature.slice(130, 132), 16),
  };
}

describe('BaseValidator', () => {
  const checkpoint: Checkpoint = {
    root: `0x${'11'.repeat(32)}`,
    index: 42,
    mailbox_domain: 5,
    merkle_tree_hook_address: `0x${'22'.repeat(20)}`,
  };
  const messageId = `0x${'33'.repeat(32)}`;

  it('recovers signer from object signature with legacy v', async () => {
    const account = privateKeyToAccount(
      `0x${'44'.repeat(32)}` as `0x${string}`,
    );
    const messageHash = BaseValidator.messageHash(checkpoint, messageId);
    const signatureHex = await account.signMessage({
      message: { raw: toHex(messageHash) },
    });
    const { r, s, v } = signatureToRSV(signatureHex);
    const legacyV = v >= 27 ? v : v + 27;

    const recovered = await BaseValidator.recoverAddressFromCheckpoint(
      checkpoint,
      { r, s, v: legacyV },
      messageId,
    );

    expect(recovered.toLowerCase()).to.equal(account.address.toLowerCase());
  });

  it('recovers signer from object signature with yParity v', async () => {
    const account = privateKeyToAccount(
      `0x${'55'.repeat(32)}` as `0x${string}`,
    );
    const messageHash = BaseValidator.messageHash(checkpoint, messageId);
    const signatureHex = await account.signMessage({
      message: { raw: toHex(messageHash) },
    });
    const { r, s, v } = signatureToRSV(signatureHex);
    const yParityV = v >= 27 ? v - 27 : v;

    const recovered = await BaseValidator.recoverAddressFromCheckpoint(
      checkpoint,
      { r, s, v: yParityV },
      messageId,
    );

    expect(recovered.toLowerCase()).to.equal(account.address.toLowerCase());
  });
});
