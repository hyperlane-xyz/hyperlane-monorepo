import { Account } from '@provablehq/sdk';

import { AleoProvider } from './clients/provider.js';
import { AleoSigner } from './clients/signer.js';

const main = async () => {
  const localnetRpc = 'http://localhost:3030';
  const provider = await AleoProvider.connect([localnetRpc], '');

  const latestBlockHeight = await provider.getHeight();
  console.log('latestBlockHeight: ', latestBlockHeight);

  // test private key with funds
  const privateKey =
    'APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH';
  const signer = await AleoSigner.connectWithSigner([localnetRpc], privateKey);

  const address = signer.getSignerAddress();
  console.log('signer address: ', address);

  const mailboxAddress = await signer.createMailbox({
    domainId: 1337,
    defaultIsmAddress: '',
  });
  console.log('mailboxAddress', mailboxAddress);

  const balance = await signer.getBalance({
    address,
    denom: '',
  });
  console.log('signer balance: ', balance);

  const bobAddress = new Account().address().to_string();

  const transferTx = await provider.getTransferTransaction({
    signer: '',
    amount: '10',
    recipient: bobAddress,
    denom: '',
  });

  const estimation = await provider.estimateTransactionFee({
    transaction: transferTx,
  });
  console.log('estimated fee for transfer:', estimation.fee);

  await signer.transfer({
    amount: '10',
    recipient: bobAddress,
    denom: '',
  });

  const balanceBob = await signer.getBalance({
    address: bobAddress,
    denom: '',
  });
  console.log('balance bob: ', balanceBob);
};

main();
