import { expect } from 'chai';
import { step } from 'mocha-steps';

import {
  bytes32ToAddress,
  isValidAddressEvm,
} from '../../../utils/dist/addresses.js';
import { formatMessage, messageId } from '../../../utils/src/messages.js';
import { SigningHyperlaneModuleClient } from '../index.js';

import { createSigner } from './utils.js';

describe('3. cosmos sdk post dispatch e2e tests', async function () {
  this.timeout(100_000);

  let signer: SigningHyperlaneModuleClient;

  before(async () => {
    signer = await createSigner('alice');
  });

  step('create new IGP hook', async () => {
    // ARRANGE
    let igps = await signer.query.postDispatch.Igps({});
    expect(igps.igps).to.have.lengthOf(0);

    const denom = 'uhyp';

    // ACT
    const txResponse = await signer.createIgp({
      denom,
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    const igp = txResponse.response;

    expect(igp.id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(igp.id))).to.be.true;

    igps = await signer.query.postDispatch.Igps({});
    expect(igps.igps).to.have.lengthOf(1);

    let igpQuery = await signer.query.postDispatch.Igp({
      id: igp.id,
    });

    expect(igpQuery.igp).not.to.be.undefined;
    expect(igpQuery.igp?.owner).to.equal(signer.account.address);
    expect(igpQuery.igp?.denom).to.equal(denom);
  });

  step('create new Merkle Tree hook', async () => {
    // ARRANGE
    let merkleTrees = await signer.query.postDispatch.MerkleTreeHooks({});
    expect(merkleTrees.merkle_tree_hooks).to.have.lengthOf(0);

    let mailboxes = await signer.query.core.Mailboxes({});
    expect(mailboxes.mailboxes).to.have.lengthOf(2);

    const mailbox = mailboxes.mailboxes[0];

    // ACT
    const txResponse = await signer.createMerkleTreeHook({
      mailbox_id: mailbox.id,
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    const merleTree = txResponse.response;

    expect(merleTree.id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(merleTree.id))).to.be.true;

    merkleTrees = await signer.query.postDispatch.MerkleTreeHooks({});
    expect(merkleTrees.merkle_tree_hooks).to.have.lengthOf(1);

    let merkleTreeQuery = await signer.query.postDispatch.MerkleTreeHook({
      id: merleTree.id,
    });

    expect(merkleTreeQuery.merkle_tree_hook).not.to.be.undefined;
    expect(merkleTreeQuery.merkle_tree_hook?.owner).to.equal(
      signer.account.address,
    );
    expect(merkleTreeQuery.merkle_tree_hook?.mailbox_id).to.equal(mailbox.id);
  });

  step('create new Noop hook', async () => {
    // ARRANGE
    let noopHooks = await signer.query.postDispatch.NoopHooks({});
    expect(noopHooks.noop_hooks).to.have.lengthOf(0);

    // ACT
    const txResponse = await signer.createNoopHook({});

    // ASSERT
    expect(txResponse.code).to.equal(0);

    const noopHook = txResponse.response;

    expect(noopHook.id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(noopHook.id))).to.be.true;

    noopHooks = await signer.query.postDispatch.NoopHooks({});
    expect(noopHooks.noop_hooks).to.have.lengthOf(1);

    let noopHookQuery = await signer.query.postDispatch.NoopHook({
      id: noopHook.id,
    });

    expect(noopHookQuery.noop_hook).not.to.be.undefined;
    expect(noopHookQuery.noop_hook?.owner).to.equal(signer.account.address);
  });

  step('set destination gas config', async () => {
    // ARRANGE
    let igps = await signer.query.postDispatch.Igps({});
    expect(igps.igps).to.have.lengthOf(1);

    const igp = igps.igps[0];
    const remoteDomainId = 1234;
    const gasOverhead = '200000';
    const gasPrice = '1';
    const tokenExchangeRate = '10000000000';

    let gasConfigs = await signer.query.postDispatch.DestinationGasConfigs({
      id: igp.id,
    });
    expect(gasConfigs.destination_gas_configs).to.have.lengthOf(0);

    // ACT
    const txResponse = await signer.setDestinationGasConfig({
      igp_id: igp.id,
      destination_gas_config: {
        remote_domain: remoteDomainId,
        gas_oracle: {
          token_exchange_rate: tokenExchangeRate,
          gas_price: gasPrice,
        },
        gas_overhead: gasOverhead,
      },
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    gasConfigs = await signer.query.postDispatch.DestinationGasConfigs({
      id: igp.id,
    });
    expect(gasConfigs.destination_gas_configs).to.have.lengthOf(1);

    const gasConfig = gasConfigs.destination_gas_configs[0];

    expect(gasConfig.remote_domain).to.equal(remoteDomainId);
    expect(gasConfig.gas_overhead).to.equal(gasOverhead);
    expect(gasConfig.gas_oracle?.gas_price).to.equal(gasPrice);
    expect(gasConfig.gas_oracle?.token_exchange_rate).to.equal(
      tokenExchangeRate,
    );
  });

  step('pay for gas', async () => {
    // ARRANGE
    const address = '0xA56009c72c0191a1D56e2feA5Bd8250707FF1874';
    const destinationDomainId = 1234;
    const denom = 'uhyp';
    const amount = {
      denom,
      amount: '1000000',
    };

    const igpCreateTxResponse = await signer.createIgp({
      denom,
    });
    expect(igpCreateTxResponse.code).to.equal(0);

    let igps = await signer.query.postDispatch.Igps({});
    expect(igps.igps).to.have.lengthOf(2);

    const igpBefore = igps.igps[igps.igps.length - 1];
    expect(igpBefore.claimable_fees).to.be.empty;

    const testMessageId = messageId(
      formatMessage(
        1,
        0,
        destinationDomainId,
        address,
        destinationDomainId,
        address,
        '0x1234',
      ),
    );

    // ACT
    const txResponse = await signer.payForGas({
      igp_id: igpBefore.id,
      message_id: testMessageId,
      destination_domain: destinationDomainId,
      gas_limit: '10000',
      amount,
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    igps = await signer.query.postDispatch.Igps({});
    expect(igps.igps).to.have.lengthOf(2);

    const igpAfter = igps.igps[igps.igps.length - 1];

    expect(igpAfter.id).to.equal(igpBefore.id);
    expect(igpAfter.denom).to.equal(igpBefore.denom);
    expect(igpAfter.claimable_fees).to.have.lengthOf(1);
    expect(igpAfter.claimable_fees[0]).deep.equal(amount);
  });

  step('claim', async () => {
    // ARRANGE
    const denom = 'uhyp';
    const amount = {
      denom,
      amount: '1000000',
    };

    let igps = await signer.query.postDispatch.Igps({});
    expect(igps.igps).to.have.lengthOf(2);

    const igpBefore = igps.igps[igps.igps.length - 1];
    expect(igpBefore.claimable_fees).to.have.lengthOf(1);
    expect(igpBefore.claimable_fees[0]).deep.equal(amount);

    // ACT
    const txResponse = await signer.claim({
      igp_id: igpBefore.id,
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    igps = await signer.query.postDispatch.Igps({});
    expect(igps.igps).to.have.lengthOf(2);

    const igpAfter = igps.igps[igps.igps.length - 1];

    expect(igpAfter.id).to.equal(igpBefore.id);
    expect(igpAfter.denom).to.equal(igpBefore.denom);
    expect(igpAfter.claimable_fees).to.be.empty;
  });

  step('set igp owner', async () => {
    // ARRANGE
    const newOwner = (await createSigner('bob')).account.address;

    let igps = await signer.query.postDispatch.Igps({});
    expect(igps.igps).to.have.lengthOf(2);

    const igpBefore = igps.igps[igps.igps.length - 1];
    expect(igpBefore.owner).to.equal(signer.account.address);

    // ACT
    const txResponse = await signer.setIgpOwner({
      igp_id: igpBefore.id,
      new_owner: newOwner,
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    igps = await signer.query.postDispatch.Igps({});
    expect(igps.igps).to.have.lengthOf(2);

    const igpAfter = igps.igps[igps.igps.length - 1];

    expect(igpAfter.id).to.equal(igpBefore.id);
    expect(igpAfter.owner).to.equal(newOwner);
    expect(igpAfter.denom).to.equal(igpBefore.denom);
  });
});
