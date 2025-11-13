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

    const balance = await signer.getBalance({
      address,
      denom: '',
    });
    console.log('signer credits balance: ', balance);

    const { mailboxAddress } = await signer.createMailbox({
      domainId: 1337,
    });
    console.log('mailboxAddress', mailboxAddress);

    const { tokenAddress } = await signer.createSyntheticToken({
      mailboxAddress,
      name: 'usdc',
      denom: 'usdc',
      decimals: 18,
    });
    console.log('tokenAddress', tokenAddress);
  } catch (err) {
    console.log(err);
  }
};

main();
