import { getCoreDeploys, getEnvironment } from './utils';
import { deployNChains } from '../src/core';

async function main() {
  const environment = await getEnvironment();
  const coreDeploys = await getCoreDeploys(environment);
  await deployNChains(coreDeploys);
}

main().then(console.log).catch(console.error);
