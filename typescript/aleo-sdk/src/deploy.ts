import { addressToBytesAleo, bytesToAddressAleo } from '@hyperlane-xyz/utils';

import { AleoSigner } from './clients/signer.js';

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

    const address = signer.getSignerAddress();
    console.log('signer address: ', address);
    const bytes = addressToBytesAleo(address);
    console.log('signer bytes', bytes);
    console.log('signer address from bytes', bytesToAddressAleo(bytes));
  } catch (err) {
    console.log(err);
  }
};

main();
