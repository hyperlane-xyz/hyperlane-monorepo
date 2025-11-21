import { Account, U128 } from '@provablehq/sdk';

import { addressToBytes32, ensure0x } from '@hyperlane-xyz/utils';

import { AleoSigner } from './clients/signer.js';
import { ALEO_NATIVE_DENOM } from './utils/helper.js';

const main = async () => {
  try {
    const localnetRpc = 'http://localhost:3030';

    // test private key with funds
    const privateKey =
      'APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH';
    const signer = await AleoSigner.connectWithSigner(
      [localnetRpc],
      privateKey,
      {
        metadata: {
          chainId: 1,
        },
      },
    );

    const domainId = 1;

    const { mailboxAddress } = await signer.createMailbox({
      domainId,
    });

    const { ismAddress } = await signer.createNoopIsm({});
    await signer.setDefaultIsm({
      mailboxAddress,
      ismAddress,
    });

    const { hookAddress } = await signer.createMerkleTreeHook({
      mailboxAddress,
    });
    await signer.setDefaultHook({
      mailboxAddress,
      hookAddress,
    });

    const { hookAddress: noopHook } = await signer.createNoopHook({
      mailboxAddress,
    });
    await signer.setRequiredHook({
      mailboxAddress,
      hookAddress: noopHook,
    });

    const { tokenAddress } = await signer.createNativeToken({
      mailboxAddress,
    });
    await signer.enrollRemoteRouter({
      tokenAddress,
      remoteRouter: {
        receiverDomainId: domainId,
        receiverAddress: addressToBytes32(tokenAddress),
        gas: '1000',
      },
    });

    const { hookAddress: igp } = await signer.createInterchainGasPaymasterHook({
      mailboxAddress,
    });
    await signer.setDestinationGasConfig({
      hookAddress: igp,
      destinationGasConfig: {
        remoteDomainId: domainId,
        gasOracle: {
          tokenExchangeRate: '5000000000',
          gasPrice: '4',
        },
        gasOverhead: '10',
      },
    });

    const quote = await signer.quoteRemoteTransfer({
      tokenAddress,
      destinationDomainId: domainId,
    });
    console.log('quote', quote); // -> { denom: '0field', amount: 25n }
    console.log('mailboxAddress', mailboxAddress);
    console.log('default ism', ismAddress);
    console.log('required hook', noopHook);
    console.log('default hook', hookAddress);
    console.log('tokenAddress', tokenAddress);

    await signer.remoteTransfer({
      tokenAddress,
      destinationDomainId: domainId,
      recipient: addressToBytes32(new Account().address().to_string()),
      amount: '1234',
      gasLimit: '1000',
      maxFee: {
        denom: ALEO_NATIVE_DENOM,
        amount: '1000000',
      },
      customHookAddress: igp,
      customHookMetadata: ensure0x(
        Buffer.from(U128.fromString('2020u128').toBytesLe()).toString('hex'),
      ),
    });

    const mailbox = await signer.getMailbox({ mailboxAddress });
    console.log(mailbox);
  } catch (err) {
    console.log(err);
  }
};

main();
