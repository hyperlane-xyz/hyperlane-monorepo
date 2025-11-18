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

    const remoteRouters = await signer.getRemoteRouters({
      tokenAddress: 'hyp_native_9rrek5ci8nc3.aleo',
    });

    console.log('remoteRouters', remoteRouters);

    await signer.unenrollRemoteRouter({
      tokenAddress: 'hyp_native_9rrek5ci8nc3.aleo',
      receiverDomainId: 1234,
    });
  } catch (err) {
    console.log(err);
  }
};

main();
