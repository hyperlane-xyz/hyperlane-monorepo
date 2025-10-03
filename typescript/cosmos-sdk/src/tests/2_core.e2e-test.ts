import { expect } from 'chai';
import { step } from 'mocha-steps';

import { AltVM } from '@hyperlane-xyz/utils';

import {
  bytes32ToAddress,
  isValidAddressEvm,
} from '../../../utils/dist/addresses.js';

import { createSigner } from './utils.js';

describe('2. cosmos sdk core e2e tests', async function () {
  this.timeout(100_000);

  let signer: AltVM.ISigner;

  before(async () => {
    signer = await createSigner('alice');
  });

  step('create new mailbox', async () => {
    // ARRANGE
    const { ismId } = await signer.createNoopIsm({});

    const domainId = 1234;

    // ACT
    const txResponse = await signer.createMailbox({
      domainId: domainId,
      defaultIsmId: ismId,
    });

    // ASSERT
    expect(txResponse.mailboxId).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.mailboxId))).to.be
      .true;

    let mailbox = await signer.getMailbox({
      mailboxId: txResponse.mailboxId,
    });

    expect(mailbox).not.to.be.undefined;
    expect(mailbox.address).to.equal(txResponse.mailboxId);
    expect(mailbox.owner).to.equal(signer.getSignerAddress());
    expect(mailbox.localDomain).to.equal(domainId);
    expect(mailbox.defaultIsm).to.equal(ismId);
    expect(mailbox.defaultHook).to.be.empty;
    expect(mailbox.requiredHook).to.be.empty;
  });

  step('set mailbox owner', async () => {
    // ARRANGE
    const { ismId } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxId } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmId: ismId,
    });

    let mailbox = await signer.getMailbox({ mailboxId });
    expect(mailbox.owner).to.equal(signer.getSignerAddress());

    const bobSigner = await createSigner('bob');

    // ACT
    await signer.setMailboxOwner({
      mailboxId,
      newOwner: bobSigner.getSignerAddress(),
    });

    // ASSERT
    mailbox = await signer.getMailbox({ mailboxId });
    expect(mailbox.owner).to.equal(bobSigner.getSignerAddress());
  });

  step('set mailbox default hook', async () => {
    // ARRANGE
    const { ismId } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxId } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmId: ismId,
    });

    const { hookId } = await signer.createMerkleTreeHook({ mailboxId });

    let mailbox = await signer.getMailbox({ mailboxId });
    expect(mailbox.defaultHook).to.be.empty;

    // ACT
    await signer.setDefaultHook({
      mailboxId,
      hookId,
    });

    // ASSERT
    mailbox = await signer.getMailbox({ mailboxId });
    expect(mailbox.defaultHook).to.equal(hookId);
  });

  step('set mailbox required hook', async () => {
    // ARRANGE
    const { ismId } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxId } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmId: ismId,
    });

    const { hookId } = await signer.createMerkleTreeHook({ mailboxId });

    let mailbox = await signer.getMailbox({ mailboxId });
    expect(mailbox.requiredHook).to.be.empty;

    // ACT
    await signer.setRequiredHook({
      mailboxId,
      hookId,
    });

    // ASSERT
    mailbox = await signer.getMailbox({ mailboxId });
    expect(mailbox.requiredHook).to.equal(hookId);
  });
});
