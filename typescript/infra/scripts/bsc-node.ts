import { MultiProvider } from '@abacus-network/sdk';

import { getCoreEnvironmentConfig } from './utils';

async function main() {
  const environment = 'mainnet';
  const config = getCoreEnvironmentConfig(environment) as any;
  const multiProvider: MultiProvider<any> = await config.getMultiProvider();
  const dc = multiProvider.getChainConnection('bsc');
  console.log(JSON.stringify(dc));
}

main().then().catch(console.error);
