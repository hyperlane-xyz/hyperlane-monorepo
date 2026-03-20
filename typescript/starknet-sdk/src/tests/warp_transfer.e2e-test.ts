import { expect } from 'chai';

import { StarknetSigner } from '../clients/signer.js';
import { DEFAULT_E2E_TEST_TIMEOUT } from '../testing/constants.js';
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
