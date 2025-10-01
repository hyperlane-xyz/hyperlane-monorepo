import { expect } from 'chai';
import { step } from 'mocha-steps';

import { MultiVM } from '@hyperlane-xyz/utils';

import {
  bytes32ToAddress,
  isValidAddressEvm,
} from '../../../utils/dist/addresses.js';

import { createSigner } from './utils.js';

describe('2. cosmos sdk core e2e tests', async function () {
  this.timeout(100_000);

  let signer: MultiVM.IMultiVMSigner;

  before(async () => {
    signer = await createSigner('alice');
  });

  step('create new mailbox', async () => {
    // ARRANGE
    const { ism_id } = await signer.createNoopIsm({});

    const domainId = 1234;

    // ACT
    const txResponse = await signer.createMailbox({
      domain_id: domainId,
      default_ism_id: ism_id,
    });

    // ASSERT
    expect(txResponse.mailbox_id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.mailbox_id))).to.be
      .true;

    let mailbox = await signer.getMailbox({
      mailbox_id: txResponse.mailbox_id,
    });

    expect(mailbox).not.to.be.undefined;
    expect(mailbox.address).to.equal(txResponse.mailbox_id);
    expect(mailbox.owner).to.equal(signer.getSignerAddress());
    expect(mailbox.local_domain).to.equal(domainId);
    expect(mailbox.default_ism).to.equal(ism_id);
    expect(mailbox.default_hook).to.be.empty;
    expect(mailbox.required_hook).to.be.empty;
  });

  step('set mailbox owner', async () => {
    // ARRANGE
    const { ism_id } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailbox_id } = await signer.createMailbox({
      domain_id: domainId,
      default_ism_id: ism_id,
    });

    let mailbox = await signer.getMailbox({ mailbox_id });
    expect(mailbox.owner).to.equal(signer.getSignerAddress());

    const bobSigner = await createSigner('bob');

    // ACT
    await signer.setMailboxOwner({
      mailbox_id,
      new_owner: bobSigner.getSignerAddress(),
    });

    // ASSERT
    mailbox = await signer.getMailbox({ mailbox_id });
    expect(mailbox.owner).to.equal(bobSigner.getSignerAddress());
  });

  step('set mailbox default hook', async () => {
    // ARRANGE
    const { ism_id } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailbox_id } = await signer.createMailbox({
      domain_id: domainId,
      default_ism_id: ism_id,
    });

    const { hook_id } = await signer.createMerkleTreeHook({ mailbox_id });

    let mailbox = await signer.getMailbox({ mailbox_id });
    expect(mailbox.default_hook).to.be.empty;

    // ACT
    await signer.setDefaultHook({
      mailbox_id,
      hook_id,
    });

    // ASSERT
    mailbox = await signer.getMailbox({ mailbox_id });
    expect(mailbox.default_hook).to.equal(hook_id);
  });

  step('set mailbox required hook', async () => {
    // ARRANGE
    const { ism_id } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailbox_id } = await signer.createMailbox({
      domain_id: domainId,
      default_ism_id: ism_id,
    });

    const { hook_id } = await signer.createMerkleTreeHook({ mailbox_id });

    let mailbox = await signer.getMailbox({ mailbox_id });
    expect(mailbox.required_hook).to.be.empty;

    // ACT
    await signer.setRequiredHook({
      mailbox_id,
      hook_id,
    });

    // ASSERT
    mailbox = await signer.getMailbox({ mailbox_id });
    expect(mailbox.required_hook).to.equal(hook_id);
  });
});
