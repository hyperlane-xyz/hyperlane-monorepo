import { Account } from '@provablehq/sdk';
import { expect } from 'chai';
import { step } from 'mocha-steps';

import { AltVM } from '@hyperlane-xyz/utils';

import { AleoSigner } from '../clients/signer.js';
import { AleoReceipt, AleoTransaction } from '../utils/types.js';

describe('2. aleo sdk core e2e tests', async function () {
  this.timeout(300_000);

  let signer: AltVM.ISigner<AleoTransaction, AleoReceipt>;

  let mailboxAddress: string;

  before(async () => {
    const localnetRpc = 'http://localhost:3030';
    // test private key with funds
    const privateKey =
      'APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH';

    signer = await AleoSigner.connectWithSigner([localnetRpc], privateKey);
  });

  step('create new mailbox', async () => {
    // ARRANGE
    const domainId = 1234;

    // ACT
    const txResponse = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: '',
    });

    // ASSERT
    expect(txResponse.mailboxAddress).to.be.not.empty;

    let mailbox = await signer.getMailbox({
      mailboxAddress: txResponse.mailboxAddress,
    });

    expect(mailbox).not.to.be.undefined;
    expect(mailbox.address).to.equal(txResponse.mailboxAddress);
    expect(mailbox.owner).to.equal(signer.getSignerAddress());
    expect(mailbox.localDomain).to.equal(domainId);
    expect(mailbox.defaultIsm).to.be.empty;
    expect(mailbox.defaultHook).to.be.empty;
    expect(mailbox.requiredHook).to.be.empty;

    mailboxAddress = mailbox.address;
  });

  step('set mailbox default ism', async () => {
    // ARRANGE
    const { ismAddress } = await signer.createNoopIsm({});

    let mailbox = await signer.getMailbox({ mailboxAddress });
    expect(mailbox.defaultIsm).to.be.empty;

    // ACT
    await signer.setDefaultIsm({
      mailboxAddress,
      ismAddress,
    });

    // ASSERT
    mailbox = await signer.getMailbox({ mailboxAddress });
    expect(mailbox.defaultIsm).to.equal(ismAddress);
  });

  step('set mailbox default hook', async () => {
    // ARRANGE
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

  step('set mailbox owner', async () => {
    // ARRANGE
    let mailbox = await signer.getMailbox({ mailboxAddress });
    expect(mailbox.owner).to.equal(signer.getSignerAddress());

    const newOwner = new Account().address().to_string();

    // ACT
    await signer.setMailboxOwner({
      mailboxAddress,
      newOwner,
    });

    // ASSERT
    mailbox = await signer.getMailbox({ mailboxAddress });
    expect(mailbox.owner).to.equal(newOwner);
  });
});
