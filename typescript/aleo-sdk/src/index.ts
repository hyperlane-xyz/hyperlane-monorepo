import { loadPrograms } from './artifacts.js';
import { AleoProvider } from './clients/provider.js';
import { AleoSigner } from './clients/signer.js';

export { AleoProvider } from './clients/provider.js';
export { AleoSigner } from './clients/signer.js';

const main = async () => {
  let programs = [
    'mailbox',
    'validator_announce',
    'ism_manager',
    'hook_manager',
    'credits',
    'dispatch_proxy',
  ];

  for (let program of programs) {
    console.log(program, loadPrograms(program));
  }

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
  console.log('signer balance: ', balance);
};

main();
