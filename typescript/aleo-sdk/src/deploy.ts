import { addressToBytes32 } from '@hyperlane-xyz/utils';

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

    const tokenAddress = 'hyp_native_e7likxgwafwz.aleo';

    const quote = await signer.quoteRemoteTransfer({
      tokenAddress: tokenAddress,
      destinationDomainId: 75898669,
    });
    console.log('quote', quote);

    const bridgedSupply = await signer.getBridgedSupply({
      tokenAddress: tokenAddress,
    });
    console.log('bridgedSupply', bridgedSupply);

    await signer.remoteTransfer({
      tokenAddress,
      destinationDomainId: 75898669,
      recipient: addressToBytes32(
        'aleo1g54sfzunsl7n895y7ydr7leklha860tayyjpd8tznpk4tmqvjgrs6vskya',
      ),
      amount: '1000000',
      gasLimit: '75000',
      maxFee: {
        denom: '0field',
        amount: '1000',
      },
    });
  } catch (err) {
    console.log(err);
  }
};

main();
