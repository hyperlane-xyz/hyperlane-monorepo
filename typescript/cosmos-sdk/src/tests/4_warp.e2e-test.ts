import { expect } from 'chai';
import { step } from 'mocha-steps';

import { AltVM } from '@hyperlane-xyz/utils';

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

  let signer: AltVM.ISigner;

  before(async () => {
    signer = await createSigner('alice');
  });

  step('create new collateral token', async () => {
    // ARRANGE
    const { ismId } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxId } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmId: ismId,
    });
    const denom = 'uhyp';

    // ACT
    const txResponse = await signer.createCollateralToken({
      mailboxId,
      originDenom: denom,
    });

    // ASSERT
    expect(txResponse.tokenId).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.tokenId))).to.be.true;

    let token = await signer.getToken({
      tokenId: txResponse.tokenId,
    });

    expect(token).not.to.be.undefined;
    expect(token.owner).to.equal(signer.getSignerAddress());
    expect(token.mailboxId).to.equal(mailboxId);
    expect(token.originDenom).to.equal(denom);
    expect(token.ismId).to.be.empty;
    expect(token.tokenType).to.equal(AltVM.TokenType.COLLATERAL);
  });

  step('create new synthetic token', async () => {
    // ARRANGE
    const { ismId } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxId } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmId: ismId,
    });

    // ACT
    const txResponse = await signer.createSyntheticToken({
      mailboxId,
    });

    // ASSERT
    expect(txResponse.tokenId).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.tokenId))).to.be.true;

    let token = await signer.getToken({
      tokenId: txResponse.tokenId,
    });

    expect(token).not.to.be.undefined;
    expect(token.owner).to.equal(signer.getSignerAddress());
    expect(token.mailboxId).to.equal(mailboxId);
    expect(token.ismId).to.be.empty;
    expect(token.tokenType).to.equal(AltVM.TokenType.SYNTHETIC);
  });

  step('enroll remote router', async () => {
    // ARRANGE
    const { ismId } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxId } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmId: ismId,
    });
    const denom = 'uhyp';

    const { tokenId } = await signer.createCollateralToken({
      mailboxId,
      originDenom: denom,
    });

    let remoteRouters = await signer.getRemoteRouters({
      tokenId,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(0);
    const gas = '10000';

    // ACT
    await signer.enrollRemoteRouter({
      tokenId,
      remoteRouter: {
        receiverDomainId: domainId,
        receiverAddress: mailboxId,
        gas,
      },
    });

    // ASSERT
    remoteRouters = await signer.getRemoteRouters({
      tokenId,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(1);

    const remoteRouter = remoteRouters.remoteRouters[0];

    expect(remoteRouter.receiverDomainId).to.equal(domainId);
    expect(remoteRouter.receiverContract).to.equal(mailboxId);
    expect(remoteRouter.gas).to.equal(gas);
  });

  step('remote transfer', async () => {
    // ARRANGE
    const { ismId } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxId } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmId: ismId,
    });
    const denom = 'uhyp';

    const { hookId: merkle_tree_hook_id } = await signer.createMerkleTreeHook({
      mailboxId,
    });

    const { hookId: igp_id } = await signer.createInterchainGasPaymasterHook({
      denom,
    });

    const gas = '10000';

    await signer.setDestinationGasConfig({
      hookId: igp_id,
      destinationGasConfig: {
        remoteDomainId: domainId,
        gasOracle: {
          tokenExchangeRate: '1',
          gasPrice: '10000000000',
        },
        gasOverhead: '200000',
      },
    });

    await signer.setRequiredHook({
      mailboxId,
      hookId: merkle_tree_hook_id,
    });

    await signer.setDefaultHook({
      mailboxId,
      hookId: igp_id,
    });

    const { tokenId } = await signer.createCollateralToken({
      mailboxId,
      originDenom: denom,
    });

    await signer.enrollRemoteRouter({
      tokenId,
      remoteRouter: {
        receiverDomainId: domainId,
        receiverAddress: mailboxId,
        gas,
      },
    });

    let remoteRouters = await signer.getRemoteRouters({
      tokenId,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(1);

    const remoteRouter = remoteRouters.remoteRouters[0];

    const interchainGas = await signer.quoteRemoteTransfer({
      tokenId,
      destinationDomainId: remoteRouter.receiverDomainId,
      customHookId: '',
      customHookMetadata: '',
    });

    // ACT
    const txResponse = await signer.remoteTransfer({
      tokenId,
      destinationDomainId: remoteRouter.receiverDomainId,
      recipient: addressToBytes32(
        convertToProtocolAddress(
          signer.getSignerAddress(),
          ProtocolType.Ethereum,
        ),
        ProtocolType.Ethereum,
      ),
      amount: '1000000',
      customHookId: '',
      gasLimit: remoteRouter.gas,
      maxFee: {
        amount: interchainGas.amount.toString(),
        denom: interchainGas.denom,
      },
      customHookMetadata: '',
    });

    // ASSERT
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.messageId))).to.be
      .true;

    let mailbox = await signer.getMailbox({ mailboxId });
    expect(mailbox.messageSent).to.equal(1);
  });

  step('unroll remote router', async () => {
    // ARRANGE
    const { ismId } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxId } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmId: ismId,
    });
    const denom = 'uhyp';

    const { hookId } = await signer.createMerkleTreeHook({
      mailboxId,
    });

    await signer.setRequiredHook({
      mailboxId,
      hookId,
    });

    await signer.setDefaultHook({
      mailboxId,
      hookId,
    });

    const { tokenId } = await signer.createCollateralToken({
      mailboxId,
      originDenom: denom,
    });

    const gas = '10000';

    await signer.enrollRemoteRouter({
      tokenId,
      remoteRouter: {
        receiverDomainId: domainId,
        receiverAddress: mailboxId,
        gas,
      },
    });

    let remoteRouters = await signer.getRemoteRouters({
      tokenId,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(1);

    // ACT
    await signer.unenrollRemoteRouter({
      tokenId,
      receiverDomainId: domainId,
    });

    // ASSERT
    remoteRouters = await signer.getRemoteRouters({
      tokenId,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(0);
  });

  step('set token owner', async () => {
    // ARRANGE
    const newOwner = (await createSigner('bob')).getSignerAddress();

    const { ismId } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxId } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmId: ismId,
    });
    const denom = 'uhyp';

    const { tokenId } = await signer.createCollateralToken({
      mailboxId,
      originDenom: denom,
    });

    let token = await signer.getToken({ tokenId });
    expect(token.owner).to.equal(signer.getSignerAddress());

    // ACT
    await signer.setTokenOwner({
      tokenId,
      newOwner: newOwner,
    });

    // ASSERT
    token = await signer.getToken({ tokenId });
    expect(token.owner).to.equal(newOwner);
  });

  step('set token ism', async () => {
    // ARRANGE
    const { ismId } = await signer.createNoopIsm({});
    const { ismId: ism_id_new } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxId } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmId: ismId,
    });
    const denom = 'uhyp';

    const { tokenId } = await signer.createCollateralToken({
      mailboxId,
      originDenom: denom,
    });

    let token = await signer.getToken({ tokenId });
    expect(token.ismId).to.be.empty;

    // ACT
    await signer.setTokenIsm({
      tokenId,
      ismId: ism_id_new,
    });

    // ASSERT
    token = await signer.getToken({ tokenId });
    expect(token.ismId).to.equal(ism_id_new);
  });
});
