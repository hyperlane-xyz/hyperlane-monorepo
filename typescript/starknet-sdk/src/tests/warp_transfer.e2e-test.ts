import { expect } from 'chai';

import { StarknetSigner } from '../clients/signer.js';
import { DEFAULT_E2E_TEST_TIMEOUT } from '../testing/constants.js';
import { TEST_STARKNET_CHAIN_METADATA } from '../testing/index.js';
import { createSigner } from '../testing/utils.js';

describe('5b. starknet sdk warp transfer e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let signer: StarknetSigner;

  before(async () => {
    signer = await createSigner();
  });

  async function createMailbox() {
    const { ismAddress } = await signer.createNoopIsm({});
    const { hookAddress } = await signer.createNoopHook({
      mailboxAddress: signer.getSignerAddress(),
    });
    const mailbox = await signer.createMailbox({
      domainId: 1234,
      defaultIsmAddress: ismAddress,
      defaultHookAddress: hookAddress,
      requiredHookAddress: hookAddress,
    });
    return mailbox.mailboxAddress;
  }

  async function assertRemoteTransfer(
    tokenAddress: string,
    mailboxAddress: string,
  ) {
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
    const token = await signer.getToken({ tokenAddress });
    expect(typeof quote.amount).to.equal('bigint');
    expect(quote.denom).to.not.equal('');

    const [beforeMailbox, beforeSenderBalance, beforeEscrowBalance] =
      await Promise.all([
        signer.getMailbox({ mailboxAddress }),
        signer.getBalance({
          denom: token.denom,
          address: signer.getSignerAddress(),
        }),
        signer.getBalance({
          denom: token.denom,
          address: tokenAddress,
        }),
      ]);
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
    const [afterMailbox, afterSenderBalance, afterEscrowBalance] =
      await Promise.all([
        signer.getMailbox({ mailboxAddress }),
        signer.getBalance({
          denom: token.denom,
          address: signer.getSignerAddress(),
        }),
        signer.getBalance({
          denom: token.denom,
          address: tokenAddress,
        }),
      ]);
    expect(afterMailbox.nonce).to.equal(beforeMailbox.nonce + 1);
    expect(afterSenderBalance < beforeSenderBalance).to.equal(true);
    expect(afterEscrowBalance > beforeEscrowBalance).to.equal(true);
  }

  it('quotes and executes native remote transfer', async () => {
    const mailboxAddress = await createMailbox();
    const { tokenAddress } = await signer.createNativeToken({ mailboxAddress });

    await assertRemoteTransfer(tokenAddress, mailboxAddress);
  });

  it('quotes and executes collateral remote transfer', async () => {
    const mailboxAddress = await createMailbox();
    const collateralDenom = TEST_STARKNET_CHAIN_METADATA.nativeToken?.denom;
    if (!collateralDenom) {
      throw new Error('Expected Starknet test collateral denom');
    }

    const { tokenAddress } = await signer.createCollateralToken({
      mailboxAddress,
      collateralDenom,
    });

    await assertRemoteTransfer(tokenAddress, mailboxAddress);
  });
});
