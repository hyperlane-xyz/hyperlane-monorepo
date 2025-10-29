import { Account } from '@provablehq/sdk';

import { AleoProvider } from './clients/provider.js';
import { AleoSigner } from './clients/signer.js';

export { AleoProvider } from './clients/provider.js';
export { AleoSigner } from './clients/signer.js';

const main = async () => {
  const localnetRpc = 'http://localhost:3030';
  const provider = await AleoProvider.connect([localnetRpc], '');

  const isHealthy = await provider.isHealthy();
  console.log('isHealthy: ', isHealthy);

  const privateKey = new Account().privateKey().to_string();
  const signer = await AleoSigner.connectWithSigner([localnetRpc], privateKey);

  const address = signer.getSignerAddress();
  console.log('signer address: ', address);
};

main();
