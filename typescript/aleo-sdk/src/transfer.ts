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

  const balance = await signer.getBalance({
    address,
    denom: '1field',
  });
  console.log('signer balance: ', balance);

  const bobAddress = new Account().address().to_string();
  console.log('bobAddress', bobAddress);

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
