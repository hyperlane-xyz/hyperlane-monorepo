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
    );

    const address = signer.getSignerAddress();
    console.log('signer address: ', address);

    const balance = await signer.getBalance({
      address,
      denom: '',
    });
    console.log('signer credits balance: ', balance);

    // const { mailboxAddress } = await signer.createMailbox({
    //   domainId: 1337,
    //   defaultIsmAddress: '',
    // });
    // console.log('mailboxAddress', mailboxAddress);

    const { tokenAddress } = await signer.createSyntheticToken({
      mailboxAddress:
        'aleo1pk3n6n5q3ktwj8n6esn0y52zj4ux4lxyqk7fz5puhs5lrjn8ucxs06f0f4',
      name: '1',
      denom: '1',
      decimals: 6,
    });
    console.log('tokenAddress', tokenAddress);
  } catch (err) {
    console.log(err);
  }
};

main();
