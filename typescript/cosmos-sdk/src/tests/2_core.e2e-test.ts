import { EncodeObject } from '@cosmjs/proto-signing';
import { DeliverTxResponse } from '@cosmjs/stargate';
import { expect } from 'chai';
import { step } from 'mocha-steps';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { bytes32ToAddress, isValidAddressEvm } from '@hyperlane-xyz/utils';

import { createSigner } from './utils.js';

describe('2. cosmos sdk core e2e tests', async function () {
  this.timeout(100_000);

  let signer: AltVM.ISigner<EncodeObject, DeliverTxResponse>;

  before(async () => {
    signer = await createSigner('alice');
  });

  step('create new mailbox', async () => {
    // ARRANGE
    const { ismAddress } = await signer.createNoopIsm({});

    const domainId = 1234;

    // ACT
    const txResponse = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: ismAddress,
    });

    // ASSERT
    expect(txResponse.mailboxAddress).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.mailboxAddress))).to.be
      .true;

    let mailbox = await signer.getMailbox({
      mailboxAddress: txResponse.mailboxAddress,
    });

    expect(mailbox).not.to.be.undefined;
    expect(mailbox.address).to.equal(txResponse.mailboxAddress);
    expect(mailbox.owner).to.equal(signer.getSignerAddress());
    expect(mailbox.localDomain).to.equal(domainId);
    expect(mailbox.defaultIsm).to.equal(ismAddress);
    expect(mailbox.defaultHook).to.be.empty;
    expect(mailbox.requiredHook).to.be.empty;
  });

  step('set mailbox owner', async () => {
    // ARRANGE
    const { ismAddress } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxAddress } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: ismAddress,
    });

    let mailbox = await signer.getMailbox({ mailboxAddress });
    expect(mailbox.owner).to.equal(signer.getSignerAddress());

    const bobSigner = await createSigner('bob');

    // ACT
    await signer.setMailboxOwner({
      mailboxAddress,
      newOwner: bobSigner.getSignerAddress(),
    });

    // ASSERT
    mailbox = await signer.getMailbox({ mailboxAddress });
    expect(mailbox.owner).to.equal(bobSigner.getSignerAddress());
  });

  step('set mailbox default hook', async () => {
    // ARRANGE
    const { ismAddress } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxAddress } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: ismAddress,
    });

    const { hookAddress } = await signer.createMerkleTreeHook({
      mailboxAddress,
    });

    let mailbox = await signer.getMailbox({ mailboxAddress });
    expect(mailbox.defaultHook).to.be.empty;

    // ACT
    await signer.setDefaultHook({
      mailboxAddress,
      hookAddress,
    });

    // ASSERT
    mailbox = await signer.getMailbox({ mailboxAddress });
    expect(mailbox.defaultHook).to.equal(hookAddress);
  });

  step('set mailbox required hook', async () => {
    // ARRANGE
    const { ismAddress } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxAddress } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: ismAddress,
    });

    const { hookAddress } = await signer.createMerkleTreeHook({
      mailboxAddress,
    });

    let mailbox = await signer.getMailbox({ mailboxAddress });
    expect(mailbox.requiredHook).to.be.empty;

    // ACT
    await signer.setRequiredHook({
      mailboxAddress,
      hookAddress,
    });

    // ASSERT
    mailbox = await signer.getMailbox({ mailboxAddress });
    expect(mailbox.requiredHook).to.equal(hookAddress);
  });
});
