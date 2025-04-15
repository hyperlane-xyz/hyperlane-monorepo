import { expect } from 'chai';
import { step } from 'mocha-steps';

import {
  bytes32ToAddress,
  isValidAddressEvm,
} from '../../../utils/dist/addresses.js';
import { createAnnounce } from '../../../utils/src/validator.js';
import { SigningHyperlaneModuleClient } from '../index.js';

import { createSigner } from './utils.js';

describe('2. cosmos sdk core e2e tests', async function () {
  this.timeout(100_000);

  let signer: SigningHyperlaneModuleClient;

  before(async () => {
    signer = await createSigner('alice');
  });

  step('create new mailbox', async () => {
    // ARRANGE
    let mailboxes = await signer.query.core.Mailboxes({});
    expect(mailboxes.mailboxes).to.have.lengthOf(0);

    const { isms } = await signer.query.interchainSecurity.DecodedIsms({});
    // take the Noop ISM
    const ismId = isms[0].id;

    const domainId = 1234;

    // ACT
    const txResponse = await signer.createMailbox({
      local_domain: domainId,
      default_ism: ismId,
      default_hook: '',
      required_hook: '',
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    const mailbox = txResponse.response;

    expect(mailbox.id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(mailbox.id))).to.be.true;

    mailboxes = await signer.query.core.Mailboxes({});
    expect(mailboxes.mailboxes).to.have.lengthOf(1);

    let mailboxQuery = await signer.query.core.Mailbox({
      id: mailbox.id,
    });

    expect(mailboxQuery.mailbox).not.to.be.undefined;
    expect(mailboxQuery.mailbox?.id).to.equal(mailbox.id);
    expect(mailboxQuery.mailbox?.owner).to.equal(signer.account.address);
    expect(mailboxQuery.mailbox?.local_domain).to.equal(domainId);
    expect(mailboxQuery.mailbox?.default_ism).to.equal(ismId);
    expect(mailboxQuery.mailbox?.default_hook).to.be.empty;
    expect(mailboxQuery.mailbox?.required_hook).to.be.empty;
  });

  step('set mailbox', async () => {
    // ARRANGE
    const newOwner = (await createSigner('bob')).account.address;

    const domainId = 1234;

    const { isms } = await signer.query.interchainSecurity.DecodedIsms({});
    // this should be a noop ISM
    const ismId = isms[0].id;

    const createMailboxTxResponse = await signer.createMailbox({
      local_domain: domainId,
      default_ism: ismId,
      default_hook: '',
      required_hook: '',
    });
    expect(createMailboxTxResponse.code).to.equal(0);

    let mailboxes = await signer.query.core.Mailboxes({});
    expect(mailboxes.mailboxes).to.have.lengthOf(2);

    const mailboxBefore = mailboxes.mailboxes[mailboxes.mailboxes.length - 1];
    expect(mailboxBefore.owner).to.equal(signer.account.address);

    // ACT
    const txResponse = await signer.setMailbox({
      mailbox_id: mailboxBefore.id,
      default_ism: '',
      default_hook: '',
      required_hook: '',
      new_owner: newOwner,
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    mailboxes = await signer.query.core.Mailboxes({});
    expect(mailboxes.mailboxes).to.have.lengthOf(2);

    const mailboxAfter = mailboxes.mailboxes[mailboxes.mailboxes.length - 1];

    expect(mailboxAfter.id).to.equal(mailboxBefore.id);
    expect(mailboxAfter.owner).to.equal(newOwner);
    expect(mailboxAfter.local_domain).to.equal(mailboxBefore.local_domain);
    expect(mailboxAfter.default_ism).to.equal(mailboxBefore.default_ism);
    expect(mailboxAfter.default_hook).to.equal(mailboxBefore.default_hook);
    expect(mailboxAfter.required_hook).to.equal(mailboxBefore.required_hook);
  });

  step('announce validator', async () => {
    // ARRANGE
    const validatorAddress = '0x0b1caf89d1edb9ee161093b1ec94ca75611db492';
    const validatorPrivKey =
      '38430941d3ea0e70f9a16192a833dbbf3541b3170781042067173bfe6cba4508';
    const storageLocation = 'aws://key.pub';

    let mailboxes = await signer.query.core.Mailboxes({});
    expect(mailboxes.mailboxes).to.have.lengthOf(2);

    const mailbox = mailboxes.mailboxes[0];

    const signature = await createAnnounce(
      validatorPrivKey,
      storageLocation,
      mailbox.id,
      mailbox.local_domain,
    );

    // ACT
    const txResponse = await signer.announceValidator({
      validator: validatorAddress,
      storage_location: storageLocation,
      signature,
      mailbox_id: mailbox.id,
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    let storageLocations =
      await signer.query.interchainSecurity.AnnouncedStorageLocations({
        mailbox_id: mailbox.id,
        validator_address: validatorAddress,
      });
    expect(storageLocations.storage_locations).to.have.lengthOf(1);
    expect(storageLocations.storage_locations[0]).to.equal(storageLocation);

    let latestStorageLocation =
      await signer.query.interchainSecurity.LatestAnnouncedStorageLocation({
        mailbox_id: mailbox.id,
        validator_address: validatorAddress,
      });
    expect(latestStorageLocation.storage_location).to.equal(storageLocation);
  });
});
