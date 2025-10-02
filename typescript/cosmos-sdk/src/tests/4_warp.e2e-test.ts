import { expect } from 'chai';
import { step } from 'mocha-steps';

import { MultiVM } from '@hyperlane-xyz/utils';

import {
  addressToBytes32,
  bytes32ToAddress,
  convertToProtocolAddress,
  isValidAddressEvm,
} from '../../../utils/src/addresses.js';
import { ProtocolType } from '../../../utils/src/types.js';

import { createSigner } from './utils.js';

describe('4. cosmos sdk warp e2e tests', async function () {
  this.timeout(100_000);

  let signer: MultiVM.ISigner;

  before(async () => {
    signer = await createSigner('alice');
  });

  step('create new collateral token', async () => {
    // ARRANGE
    const { ism_id } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailbox_id } = await signer.createMailbox({
      domain_id: domainId,
      default_ism_id: ism_id,
    });
    const denom = 'uhyp';

    // ACT
    const txResponse = await signer.createCollateralToken({
      mailbox_id,
      origin_denom: denom,
    });

    // ASSERT
    expect(txResponse.token_id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.token_id))).to.be.true;

    let token = await signer.getToken({
      token_id: txResponse.token_id,
    });

    expect(token).not.to.be.undefined;
    expect(token.owner).to.equal(signer.getSignerAddress());
    expect(token.mailbox_id).to.equal(mailbox_id);
    expect(token.origin_denom).to.equal(denom);
    expect(token.ism_id).to.be.empty;
    expect(token.token_type).to.equal(MultiVM.TokenType.COLLATERAL);
  });

  step('create new synthetic token', async () => {
    // ARRANGE
    const { ism_id } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailbox_id } = await signer.createMailbox({
      domain_id: domainId,
      default_ism_id: ism_id,
    });

    // ACT
    const txResponse = await signer.createSyntheticToken({
      mailbox_id,
    });

    // ASSERT
    expect(txResponse.token_id).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.token_id))).to.be.true;

    let token = await signer.getToken({
      token_id: txResponse.token_id,
    });

    expect(token).not.to.be.undefined;
    expect(token.owner).to.equal(signer.getSignerAddress());
    expect(token.mailbox_id).to.equal(mailbox_id);
    expect(token.ism_id).to.be.empty;
    expect(token.token_type).to.equal(MultiVM.TokenType.SYNTHETIC);
  });

  step('enroll remote router', async () => {
    // ARRANGE
    const { ism_id } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailbox_id } = await signer.createMailbox({
      domain_id: domainId,
      default_ism_id: ism_id,
    });
    const denom = 'uhyp';

    const { token_id } = await signer.createCollateralToken({
      mailbox_id,
      origin_denom: denom,
    });

    let remoteRouters = await signer.getRemoteRouters({
      token_id,
    });
    expect(remoteRouters.remote_routers).to.have.lengthOf(0);
    const gas = '10000';

    // ACT
    await signer.enrollRemoteRouter({
      token_id,
      remote_router: {
        receiver_domain_id: domainId,
        receiver_address: mailbox_id,
        gas,
      },
    });

    // ASSERT
    remoteRouters = await signer.getRemoteRouters({
      token_id,
    });
    expect(remoteRouters.remote_routers).to.have.lengthOf(1);

    const remoteRouter = remoteRouters.remote_routers[0];

    expect(remoteRouter.receiver_domain_id).to.equal(domainId);
    expect(remoteRouter.receiver_contract).to.equal(mailbox_id);
    expect(remoteRouter.gas).to.equal(gas);
  });

  step('remote transfer', async () => {
    // ARRANGE
    const { ism_id } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailbox_id } = await signer.createMailbox({
      domain_id: domainId,
      default_ism_id: ism_id,
    });
    const denom = 'uhyp';

    const { hook_id: merkle_tree_hook_id } = await signer.createMerkleTreeHook({
      mailbox_id,
    });

    const { hook_id: igp_id } = await signer.createInterchainGasPaymasterHook({
      denom,
    });

    const gas = '10000';

    await signer.setDestinationGasConfig({
      hook_id: igp_id,
      destination_gas_config: {
        remote_domain_id: domainId,
        gas_oracle: {
          token_exchange_rate: '1',
          gas_price: '10000000000',
        },
        gas_overhead: '200000',
      },
    });

    await signer.setRequiredHook({
      mailbox_id,
      hook_id: merkle_tree_hook_id,
    });

    await signer.setDefaultHook({
      mailbox_id,
      hook_id: igp_id,
    });

    const { token_id } = await signer.createCollateralToken({
      mailbox_id,
      origin_denom: denom,
    });

    await signer.enrollRemoteRouter({
      token_id,
      remote_router: {
        receiver_domain_id: domainId,
        receiver_address: mailbox_id,
        gas,
      },
    });

    let remoteRouters = await signer.getRemoteRouters({
      token_id,
    });
    expect(remoteRouters.remote_routers).to.have.lengthOf(1);

    const remoteRouter = remoteRouters.remote_routers[0];

    const interchainGas = await signer.quoteRemoteTransfer({
      token_id,
      destination_domain_id: remoteRouter.receiver_domain_id,
      custom_hook_id: '',
      custom_hook_metadata: '',
    });

    // ACT
    const txResponse = await signer.remoteTransfer({
      token_id,
      destination_domain_id: remoteRouter.receiver_domain_id,
      recipient: addressToBytes32(
        convertToProtocolAddress(
          signer.getSignerAddress(),
          ProtocolType.Ethereum,
        ),
        ProtocolType.Ethereum,
      ),
      amount: '1000000',
      custom_hook_id: '',
      gas_limit: remoteRouter.gas,
      max_fee: {
        amount: interchainGas.amount.toString(),
        denom: interchainGas.denom,
      },
      custom_hook_metadata: '',
    });

    // ASSERT
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.message_id))).to.be
      .true;

    let mailbox = await signer.getMailbox({ mailbox_id });
    expect(mailbox.message_sent).to.equal(1);
  });

  step('unroll remote router', async () => {
    // ARRANGE
    const { ism_id } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailbox_id } = await signer.createMailbox({
      domain_id: domainId,
      default_ism_id: ism_id,
    });
    const denom = 'uhyp';

    const { hook_id } = await signer.createMerkleTreeHook({
      mailbox_id,
    });

    await signer.setRequiredHook({
      mailbox_id,
      hook_id,
    });

    await signer.setDefaultHook({
      mailbox_id,
      hook_id,
    });

    const { token_id } = await signer.createCollateralToken({
      mailbox_id,
      origin_denom: denom,
    });

    const gas = '10000';

    await signer.enrollRemoteRouter({
      token_id,
      remote_router: {
        receiver_domain_id: domainId,
        receiver_address: mailbox_id,
        gas,
      },
    });

    let remoteRouters = await signer.getRemoteRouters({
      token_id,
    });
    expect(remoteRouters.remote_routers).to.have.lengthOf(1);

    // ACT
    await signer.unenrollRemoteRouter({
      token_id,
      receiver_domain_id: domainId,
    });

    // ASSERT
    remoteRouters = await signer.getRemoteRouters({
      token_id,
    });
    expect(remoteRouters.remote_routers).to.have.lengthOf(0);
  });

  step('set token owner', async () => {
    // ARRANGE
    const newOwner = (await createSigner('bob')).getSignerAddress();

    const { ism_id } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailbox_id } = await signer.createMailbox({
      domain_id: domainId,
      default_ism_id: ism_id,
    });
    const denom = 'uhyp';

    const { token_id } = await signer.createCollateralToken({
      mailbox_id,
      origin_denom: denom,
    });

    let token = await signer.getToken({ token_id });
    expect(token.owner).to.equal(signer.getSignerAddress());

    // ACT
    await signer.setTokenOwner({
      token_id,
      new_owner: newOwner,
    });

    // ASSERT
    token = await signer.getToken({ token_id });
    expect(token.owner).to.equal(newOwner);
  });

  step('set token ism', async () => {
    // ARRANGE
    const { ism_id } = await signer.createNoopIsm({});
    const { ism_id: ism_id_new } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailbox_id } = await signer.createMailbox({
      domain_id: domainId,
      default_ism_id: ism_id,
    });
    const denom = 'uhyp';

    const { token_id } = await signer.createCollateralToken({
      mailbox_id,
      origin_denom: denom,
    });

    let token = await signer.getToken({ token_id });
    expect(token.ism_id).to.be.empty;

    // ACT
    await signer.setTokenIsm({
      token_id,
      ism_id: ism_id_new,
    });

    // ASSERT
    token = await signer.getToken({ token_id });
    expect(token.ism_id).to.equal(ism_id_new);
  });
});
