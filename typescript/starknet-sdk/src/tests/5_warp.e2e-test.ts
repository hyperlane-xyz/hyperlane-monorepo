import { expect } from 'chai';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { eqAddressStarknet } from '@hyperlane-xyz/utils';

import { StarknetSigner } from '../clients/signer.js';
import { DEFAULT_E2E_TEST_TIMEOUT } from '../testing/constants.js';
import { createSigner } from '../testing/utils.js';

describe('5. starknet sdk warp e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let signer: StarknetSigner;

  before(async () => {
    signer = await createSigner();
  });

  async function createMailbox() {
    const { ismAddress } = await signer.createNoopIsm({});
    const mailbox = await signer.createMailbox({
      domainId: 1234,
      defaultIsmAddress: ismAddress,
    });
    return mailbox.mailboxAddress;
  }

  it('creates and reads native token', async () => {
    const mailboxAddress = await createMailbox();
    const created = await signer.createNativeToken({ mailboxAddress });

    const token = await signer.getToken({ tokenAddress: created.tokenAddress });
    expect(token.tokenType).to.equal(AltVM.TokenType.native);
    expect(eqAddressStarknet(token.owner, signer.getSignerAddress())).to.equal(true);
    expect(eqAddressStarknet(token.mailboxAddress, mailboxAddress)).to.equal(true);
  });

  it('creates and reads synthetic token', async () => {
    const mailboxAddress = await createMailbox();
    const created = await signer.createSyntheticToken({
      mailboxAddress,
      name: 'TEST',
      denom: 'TEST',
      decimals: 18,
    });

    const token = await signer.getToken({ tokenAddress: created.tokenAddress });
    expect(token.tokenType).to.equal(AltVM.TokenType.synthetic);
    expect(eqAddressStarknet(token.owner, signer.getSignerAddress())).to.equal(true);
    expect(eqAddressStarknet(token.mailboxAddress, mailboxAddress)).to.equal(true);
    expect(token.decimals).to.equal(18);
  });

  it('sets token ism/hook/owner', async () => {
    const mailboxAddress = await createMailbox();
    const { tokenAddress } = await signer.createNativeToken({ mailboxAddress });
    const { ismAddress } = await signer.createNoopIsm({});
    const { hookAddress } = await signer.createNoopHook({ mailboxAddress });

    await signer.setTokenIsm({ tokenAddress, ismAddress });
    await signer.setTokenHook({ tokenAddress, hookAddress });

    const newOwner =
      '0x7777777777777777777777777777777777777777777777777777777777777777';
    await signer.setTokenOwner({ tokenAddress, newOwner });

    const token = await signer.getToken({ tokenAddress });
    expect(eqAddressStarknet(token.ismAddress, ismAddress)).to.equal(true);
    expect(eqAddressStarknet(token.hookAddress, hookAddress)).to.equal(true);
    expect(eqAddressStarknet(token.owner, newOwner)).to.equal(true);
  });

  it('enrolls and unenrolls remote router', async () => {
    const mailboxAddress = await createMailbox();
    const { tokenAddress } = await signer.createNativeToken({ mailboxAddress });

    const empty = await signer.getRemoteRouters({ tokenAddress });
    expect(empty.remoteRouters).to.have.length(0);

    await signer.enrollRemoteRouter({
      tokenAddress,
      remoteRouter: {
        receiverDomainId: 1234,
        receiverAddress: signer.getSignerAddress(),
        gas: '200000',
      },
    });

    const enrolled = await signer.getRemoteRouters({ tokenAddress });
    expect(enrolled.remoteRouters).to.have.length(1);
    expect(enrolled.remoteRouters[0].receiverDomainId).to.equal(1234);
    expect(
      eqAddressStarknet(
        enrolled.remoteRouters[0].receiverAddress,
        signer.getSignerAddress(),
      ),
    ).to.equal(true);

    await signer.unenrollRemoteRouter({
      tokenAddress,
      receiverDomainId: 1234,
    });

    const cleared = await signer.getRemoteRouters({ tokenAddress });
    expect(cleared.remoteRouters).to.have.length(0);
  });

  it('quotes and executes remote transfer', async () => {
    const mailboxAddress = await createMailbox();
    const { tokenAddress } = await signer.createNativeToken({ mailboxAddress });

    await signer.enrollRemoteRouter({
      tokenAddress,
      remoteRouter: {
        receiverDomainId: 1234,
        receiverAddress: signer.getSignerAddress(),
        gas: '200000',
      },
    });

    const quote = await signer.quoteRemoteTransfer({
      tokenAddress,
      destinationDomainId: 1234,
    });
    expect(typeof quote.amount).to.equal('bigint');
    expect(quote.denom).to.not.equal('');

    const before = await signer.getMailbox({ mailboxAddress });
    await signer.remoteTransfer({
      tokenAddress,
      destinationDomainId: 1234,
      recipient: signer.getSignerAddress(),
      amount: '1',
      gasLimit: '200000',
      maxFee: {
        denom: quote.denom,
        amount: quote.amount.toString(),
      },
    });
    const after = await signer.getMailbox({ mailboxAddress });
    expect(after.nonce).to.equal(before.nonce + 1);
  });
});
