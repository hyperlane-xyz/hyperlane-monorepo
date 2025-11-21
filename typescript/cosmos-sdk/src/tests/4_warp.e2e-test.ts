import { EncodeObject } from '@cosmjs/proto-signing';
import { DeliverTxResponse } from '@cosmjs/stargate';
import { expect } from 'chai';
import { step } from 'mocha-steps';

import {
  AltVM,
  addressToBytes32,
  bytes32ToAddress,
  convertToProtocolAddress,
  isValidAddressEvm,
} from '@hyperlane-xyz/utils';

import { ProtocolType } from '../../../utils/src/types.js';

import { createSigner } from './utils.js';

describe('4. cosmos sdk warp e2e tests', async function () {
  this.timeout(100_000);

  let signer: AltVM.ISigner<EncodeObject, DeliverTxResponse>;

  before(async () => {
    signer = await createSigner('alice');
  });

  step('create new collateral token', async () => {
    // ARRANGE
    const { ismAddress } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxAddress } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: ismAddress,
    });
    const denom = 'uhyp';

    // ACT
    const txResponse = await signer.createCollateralToken({
      mailboxAddress,
      collateralDenom: denom,
    });

    // ASSERT
    expect(txResponse.tokenAddress).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.tokenAddress))).to.be
      .true;

    let token = await signer.getToken({
      tokenAddress: txResponse.tokenAddress,
    });

    expect(token).not.to.be.undefined;
    expect(token.owner).to.equal(signer.getSignerAddress());
    expect(token.mailboxAddress).to.equal(mailboxAddress);
    expect(token.denom).to.equal(denom);
    expect(token.ismAddress).to.be.empty;
    expect(token.hookAddress).to.be.empty;
    expect(token.tokenType).to.equal(AltVM.TokenType.collateral);
  });

  step('create new synthetic token', async () => {
    // ARRANGE
    const { ismAddress } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxAddress } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: ismAddress,
    });

    // ACT
    const txResponse = await signer.createSyntheticToken({
      mailboxAddress,
      name: '',
      denom: '',
      decimals: 0,
    });

    // ASSERT
    expect(txResponse.tokenAddress).to.be.not.empty;
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.tokenAddress))).to.be
      .true;

    let token = await signer.getToken({
      tokenAddress: txResponse.tokenAddress,
    });

    expect(token).not.to.be.undefined;
    expect(token.owner).to.equal(signer.getSignerAddress());
    expect(token.mailboxAddress).to.equal(mailboxAddress);
    expect(token.ismAddress).to.be.empty;
    expect(token.tokenType).to.equal(AltVM.TokenType.synthetic);
  });

  step('enroll remote router', async () => {
    // ARRANGE
    const { ismAddress } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxAddress } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: ismAddress,
    });
    const denom = 'uhyp';

    const { tokenAddress } = await signer.createCollateralToken({
      mailboxAddress,
      collateralDenom: denom,
    });

    let remoteRouters = await signer.getRemoteRouters({
      tokenAddress,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(0);
    const gas = '10000';

    // ACT
    await signer.enrollRemoteRouter({
      tokenAddress,
      remoteRouter: {
        receiverDomainId: domainId,
        receiverAddress: mailboxAddress,
        gas,
      },
    });

    // ASSERT
    remoteRouters = await signer.getRemoteRouters({
      tokenAddress,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(1);

    const remoteRouter = remoteRouters.remoteRouters[0];

    expect(remoteRouter.receiverDomainId).to.equal(domainId);
    expect(remoteRouter.receiverAddress).to.equal(mailboxAddress);
    expect(remoteRouter.gas).to.equal(gas);
  });

  step('remote transfer', async () => {
    // ARRANGE
    const { ismAddress } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxAddress } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: ismAddress,
    });
    const denom = 'uhyp';

    const { hookAddress: merkle_tree_hook_id } =
      await signer.createMerkleTreeHook({
        mailboxAddress,
      });

    const { hookAddress: igp_id } =
      await signer.createInterchainGasPaymasterHook({
        mailboxAddress,
        denom,
      });

    const gas = '10000';

    await signer.setDestinationGasConfig({
      hookAddress: igp_id,
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
      mailboxAddress,
      hookAddress: merkle_tree_hook_id,
    });

    await signer.setDefaultHook({
      mailboxAddress,
      hookAddress: igp_id,
    });

    const { tokenAddress } = await signer.createCollateralToken({
      mailboxAddress,
      collateralDenom: denom,
    });

    await signer.enrollRemoteRouter({
      tokenAddress,
      remoteRouter: {
        receiverDomainId: domainId,
        receiverAddress: mailboxAddress,
        gas,
      },
    });

    let remoteRouters = await signer.getRemoteRouters({
      tokenAddress,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(1);

    const remoteRouter = remoteRouters.remoteRouters[0];

    const interchainGas = await signer.quoteRemoteTransfer({
      tokenAddress,
      destinationDomainId: remoteRouter.receiverDomainId,
      customHookAddress: '',
      customHookMetadata: '',
    });

    // ACT
    const txResponse = await signer.remoteTransfer({
      tokenAddress,
      destinationDomainId: remoteRouter.receiverDomainId,
      recipient: addressToBytes32(
        convertToProtocolAddress(
          signer.getSignerAddress(),
          ProtocolType.Ethereum,
        ),
        ProtocolType.Ethereum,
      ),
      amount: '1000000',
      customHookAddress: '',
      gasLimit: remoteRouter.gas,
      maxFee: {
        amount: interchainGas.amount.toString(),
        denom: interchainGas.denom,
      },
      customHookMetadata: '',
    });

    // ASSERT
    expect(isValidAddressEvm(bytes32ToAddress(txResponse.tokenAddress))).to.be
      .true;

    let mailbox = await signer.getMailbox({ mailboxAddress });
    expect(mailbox.nonce).to.equal(1);
  });

  step('unenroll remote router', async () => {
    // ARRANGE
    const { ismAddress } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxAddress } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: ismAddress,
    });
    const denom = 'uhyp';

    const { hookAddress } = await signer.createMerkleTreeHook({
      mailboxAddress,
    });

    await signer.setRequiredHook({
      mailboxAddress,
      hookAddress,
    });

    await signer.setDefaultHook({
      mailboxAddress,
      hookAddress,
    });

    const { tokenAddress } = await signer.createCollateralToken({
      mailboxAddress,
      collateralDenom: denom,
    });

    const gas = '10000';

    await signer.enrollRemoteRouter({
      tokenAddress,
      remoteRouter: {
        receiverDomainId: domainId,
        receiverAddress: mailboxAddress,
        gas,
      },
    });

    let remoteRouters = await signer.getRemoteRouters({
      tokenAddress,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(1);

    // ACT
    await signer.unenrollRemoteRouter({
      tokenAddress,
      receiverDomainId: domainId,
    });

    // ASSERT
    remoteRouters = await signer.getRemoteRouters({
      tokenAddress,
    });
    expect(remoteRouters.remoteRouters).to.have.lengthOf(0);
  });

  step('set token owner', async () => {
    // ARRANGE
    const newOwner = (await createSigner('bob')).getSignerAddress();

    const { ismAddress } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxAddress } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: ismAddress,
    });
    const denom = 'uhyp';

    const { tokenAddress } = await signer.createCollateralToken({
      mailboxAddress,
      collateralDenom: denom,
    });

    let token = await signer.getToken({ tokenAddress });
    expect(token.owner).to.equal(signer.getSignerAddress());

    // ACT
    await signer.setTokenOwner({
      tokenAddress,
      newOwner: newOwner,
    });

    // ASSERT
    token = await signer.getToken({ tokenAddress });
    expect(token.owner).to.equal(newOwner);
  });

  step('set token ism', async () => {
    // ARRANGE
    const { ismAddress } = await signer.createNoopIsm({});
    const { ismAddress: ism_id_new } = await signer.createNoopIsm({});

    const domainId = 1234;

    const { mailboxAddress } = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: ismAddress,
    });
    const denom = 'uhyp';

    const { tokenAddress } = await signer.createCollateralToken({
      mailboxAddress,
      collateralDenom: denom,
    });

    let token = await signer.getToken({ tokenAddress });
    expect(token.ismAddress).to.be.empty;

    // ACT
    await signer.setTokenIsm({
      tokenAddress,
      ismAddress: ism_id_new,
    });

    // ASSERT
    token = await signer.getToken({ tokenAddress });
    expect(token.ismAddress).to.equal(ism_id_new);
  });
});
