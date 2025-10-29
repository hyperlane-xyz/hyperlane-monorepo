import { AleoProvider } from './clients/provider.js';

export { AleoProvider } from './clients/provider.js';

const main = async () => {
  const localnetRpc = 'http://localhost:3030';
  const provider = await AleoProvider.connect([localnetRpc], '');

  const isHealthy = await provider.isHealthy();
  console.log('isHealthy: ', isHealthy);
};

main();
