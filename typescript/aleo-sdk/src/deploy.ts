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
    denom: '',
  });
  console.log('signer credits balance: ', balance);

  // const { hookAddress } = await signer.createInterchainGasPaymasterHook({
  //   denom: '',
  // });
  // console.log('hookAddress', hookAddress);

  await signer.setDestinationGasConfig({
    hookAddress:
      'aleo1luec7p59xlxlldvh697073yn6prwpv59ax32utu6tpq40c4ahs9q3axudk',
    destinationGasConfig: {
      remoteDomainId: 1337,
      gasOverhead: '1000',
      gasOracle: {
        tokenExchangeRate: '1000',
        gasPrice: '1',
      },
    },
  });
};

main();
