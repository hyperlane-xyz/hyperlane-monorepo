import { expect } from 'chai';
import { step } from 'mocha-steps';

import { HypTokenType } from '../../../cosmos-types/src/types/hyperlane/warp/v1/types.js';
import {
  addressToBytes32,
  bytes32ToAddress,
  convertToProtocolAddress,
  isValidAddressEvm,
} from '../../../utils/src/addresses.js';
import { formatMessage } from '../../../utils/src/messages.js';
import { ProtocolType } from '../../../utils/src/types.js';
import { SigningHyperlaneModuleClient } from '../index.js';

import { createSigner } from './utils.js';

describe('4. cosmos sdk warp e2e tests', async function () {
  this.timeout(100_000);

  let signer: SigningHyperlaneModuleClient;

  before(async () => {
    signer = await createSigner('alice');
  });

  step('create new collateral token', async () => {
    // ARRANGE
    let tokens = await signer.query.warp.Tokens({});
    expect(tokens.tokens).to.have.lengthOf(0);

    let mailboxes = await signer.query.core.Mailboxes({});
    expect(mailboxes.mailboxes).to.have.lengthOf(2);

    const mailbox = mailboxes.mailboxes[0];
    const denom = 'uhyp';

    // ACT
    const txResponse = await signer.createCollateralToken({
      origin_mailbox: mailbox.id,
      origin_denom: denom,
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    const token = txResponse.response;

    expect(token.id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(token.id))).to.be.true;

    tokens = await signer.query.warp.Tokens({});
    expect(tokens.tokens).to.have.lengthOf(1);

    let tokenQuery = await signer.query.warp.Token({
      id: token.id,
    });

    expect(tokenQuery.token).not.to.be.undefined;
    expect(tokenQuery.token?.owner).to.equal(signer.account.address);
    expect(tokenQuery.token?.origin_mailbox).to.equal(mailbox.id);
    expect(tokenQuery.token?.origin_denom).to.equal(denom);
    expect(tokenQuery.token?.ism_id).to.be.empty;
    expect(tokenQuery.token?.token_type).to.equal(
      HypTokenType.HYP_TOKEN_TYPE_COLLATERAL,
    );
  });

  step('create new synthetic token', async () => {
    // ARRANGE
    let tokens = await signer.query.warp.Tokens({});
    expect(tokens.tokens).to.have.lengthOf(1);

    let mailboxes = await signer.query.core.Mailboxes({});
    expect(mailboxes.mailboxes).to.have.lengthOf(2);

    const mailbox = mailboxes.mailboxes[0];

    // ACT
    const txResponse = await signer.createSyntheticToken({
      origin_mailbox: mailbox.id,
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    const token = txResponse.response;

    expect(token.id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(token.id))).to.be.true;

    tokens = await signer.query.warp.Tokens({});
    expect(tokens.tokens).to.have.lengthOf(2);

    let tokenQuery = await signer.query.warp.Token({
      id: token.id,
    });

    expect(tokenQuery.token).not.to.be.undefined;
    expect(tokenQuery.token?.owner).to.equal(signer.account.address);
    expect(tokenQuery.token?.origin_mailbox).to.equal(mailbox.id);
    expect(tokenQuery.token?.origin_denom).to.equal(`hyperlane/${token.id}`);
    expect(tokenQuery.token?.ism_id).to.be.empty;
    expect(tokenQuery.token?.token_type).to.equal(
      HypTokenType.HYP_TOKEN_TYPE_SYNTHETIC,
    );
  });

  step('enroll remote router', async () => {
    // ARRANGE
    let tokens = await signer.query.warp.Tokens({});
    expect(tokens.tokens).to.have.lengthOf(2);

    const token = tokens.tokens[0];

    let mailboxes = await signer.query.core.Mailboxes({});
    expect(mailboxes.mailboxes).to.have.lengthOf(2);

    const mailbox = mailboxes.mailboxes[0];

    let remoteRouters = await signer.query.warp.RemoteRouters({
      id: token.id,
    });
    expect(remoteRouters.remote_routers).to.have.lengthOf(0);
    const gas = '10000';

    // ACT
    const txResponse = await signer.enrollRemoteRouter({
      token_id: token.id,
      remote_router: {
        receiver_domain: mailbox.local_domain,
        receiver_contract: mailbox.id,
        gas,
      },
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    remoteRouters = await signer.query.warp.RemoteRouters({
      id: token.id,
    });
    expect(remoteRouters.remote_routers).to.have.lengthOf(1);

    const remoteRouter = remoteRouters.remote_routers[0];

    expect(remoteRouter.receiver_domain).to.equal(mailbox.local_domain);
    expect(remoteRouter.receiver_contract).to.equal(mailbox.id);
    expect(remoteRouter.gas).to.equal(gas);
  });

  step('remote transfer', async () => {
    // ARRANGE
    let tokens = await signer.query.warp.Tokens({});
    expect(tokens.tokens).to.have.lengthOf(2);

    const token = tokens.tokens[0];

    let mailboxes = await signer.query.core.Mailboxes({});
    expect(mailboxes.mailboxes).to.have.lengthOf(2);

    let mailbox = mailboxes.mailboxes[0];
    expect(mailbox.message_sent).to.equal(0);

    const isms = await signer.query.interchainSecurity.DecodedIsms({});
    const igps = await signer.query.postDispatch.Igps({});
    const merkleTreeHooks = await signer.query.postDispatch.MerkleTreeHooks({});

    const mailboxTxResponse = await signer.setMailbox({
      mailbox_id: mailbox.id,
      default_ism: isms.isms[0].id,
      default_hook: igps.igps[0].id,
      required_hook: merkleTreeHooks.merkle_tree_hooks[0].id,
      new_owner: '',
      renounce_ownership: false,
    });
    expect(mailboxTxResponse.code).to.equal(0);

    let remoteRouters = await signer.query.warp.RemoteRouters({
      id: token.id,
    });
    expect(remoteRouters.remote_routers).to.have.lengthOf(1);

    const remoteRouter = remoteRouters.remote_routers[0];

    const interchainGas = await signer.query.warp.QuoteRemoteTransfer({
      id: token.id,
      destination_domain: remoteRouter.receiver_domain.toString(),
    });

    // ACT
    const txResponse = await signer.remoteTransfer({
      token_id: token.id,
      destination_domain: remoteRouter.receiver_domain,
      recipient: addressToBytes32(
        convertToProtocolAddress(signer.account.address, ProtocolType.Ethereum),
        ProtocolType.Ethereum,
      ),
      amount: '1000000',
      custom_hook_id: '',
      gas_limit: remoteRouter.gas,
      max_fee: interchainGas.gas_payment[0],
      custom_hook_metadata: '',
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    const messageId = txResponse.response.message_id;
    expect(isValidAddressEvm(bytes32ToAddress(messageId))).to.be.true;

    mailboxes = await signer.query.core.Mailboxes({});
    expect(mailboxes.mailboxes).to.have.lengthOf(2);

    mailbox = mailboxes.mailboxes[0];
    expect(mailbox.message_sent).to.equal(1);
  });

  step('process message', async () => {
    // ARRANGE
    const domainId = 1234;
    const gas = '10000';

    let mailboxes = await signer.query.core.Mailboxes({});
    expect(mailboxes.mailboxes).to.have.lengthOf(2);

    const mailboxBefore = mailboxes.mailboxes[0];
    expect(mailboxBefore.message_received).to.equal(0);

    let tokens = await signer.query.warp.Tokens({});
    expect(tokens.tokens).to.have.lengthOf(2);

    const token = tokens.tokens[1];

    const routerTxResponse = await signer.enrollRemoteRouter({
      token_id: token.id,
      remote_router: {
        receiver_domain: mailboxBefore.local_domain,
        receiver_contract: mailboxBefore.id,
        gas,
      },
    });

    expect(routerTxResponse.code).to.equal(0);

    const message = formatMessage(
      3,
      0,
      domainId,
      mailboxBefore.id,
      mailboxBefore.local_domain,
      token.id,
      '0x0000000000000000000000000c60e7ecd06429052223c78452f791aab5c5cac60000000000000000000000000000000000000000000000000000000002faf080',
    );

    // ACT
    const txResponse = await signer.processMessage({
      mailbox_id: mailboxBefore.id,
      metadata: '',
      message,
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    mailboxes = await signer.query.core.Mailboxes({});
    expect(mailboxes.mailboxes).to.have.lengthOf(2);

    const mailboxAfter = mailboxes.mailboxes[0];
    expect(mailboxAfter.message_received).to.equal(1);
  });

  step('unroll remote router', async () => {
    // ARRANGE
    let tokens = await signer.query.warp.Tokens({});
    expect(tokens.tokens).to.have.lengthOf(2);

    const token = tokens.tokens[0];

    let remoteRouters = await signer.query.warp.RemoteRouters({
      id: token.id,
    });
    expect(remoteRouters.remote_routers).to.have.lengthOf(1);

    const receiverDomainId = 1234;

    // ACT
    const txResponse = await signer.unrollRemoteRouter({
      token_id: token.id,
      receiver_domain: receiverDomainId,
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    remoteRouters = await signer.query.warp.RemoteRouters({
      id: token.id,
    });
    expect(remoteRouters.remote_routers).to.have.lengthOf(0);
  });

  step('set token', async () => {
    // ARRANGE
    const newOwner = (await createSigner('bob')).account.address;

    let tokens = await signer.query.warp.Tokens({});
    expect(tokens.tokens).to.have.lengthOf(2);

    const tokenBefore = tokens.tokens[tokens.tokens.length - 1];

    // ACT
    const txResponse = await signer.setToken({
      token_id: tokenBefore.id,
      ism_id: '',
      new_owner: newOwner,
      renounce_ownership: false,
    });

    // ASSERT
    expect(txResponse.code).to.equal(0);

    tokens = await signer.query.warp.Tokens({});
    expect(tokens.tokens).to.have.lengthOf(2);

    const tokenAfter = tokens.tokens[tokens.tokens.length - 1];

    expect(tokenAfter.id).to.equal(tokenBefore.id);
    expect(tokenAfter.owner).to.equal(newOwner);
    expect(tokenAfter.origin_mailbox).to.equal(tokenBefore.origin_mailbox);
    expect(tokenAfter.origin_denom).to.equal(tokenBefore.origin_denom);
    expect(tokenAfter.ism_id).to.equal(tokenBefore.ism_id);
    expect(tokenAfter.token_type).to.equal(tokenBefore.token_type);
  });
});
