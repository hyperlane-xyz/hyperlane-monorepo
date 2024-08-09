import { getRegistryForEnvironment } from '../../src/config/chain.js';
import { setAndVerifyRpcUrls } from '../../src/utils/rpcUrls.js';
import { getArgs, withChains } from '../agent-utils.js';

async function main() {
  const { environment, chains } = await withChains(getArgs()).argv;

  if (!chains || chains.length === 0) {
    console.error('No chains provided, Exiting.');
    process.exit(1);
  }

  console.log(
    `Setting RPC URLs for chains: ${chains.join(
      ', ',
    )} in ${environment} environment`,
  );

  const registry = await getRegistryForEnvironment(
    environment,
    chains,
    undefined,
    false,
  );

  for (const chain of chains) {
    console.log(`\nSetting RPC URLs for chain: ${chain}`);
    const chainMetadata = await registry.getChainMetadata(chain);
    if (!chainMetadata) {
      console.error(`Chain ${chain} not found in registry. Continuing...`);
      continue;
    }

    const rpcUrlsArray = chainMetadata.rpcUrls.map((rpc) => rpc.http);
    await setAndVerifyRpcUrls(environment, chain, rpcUrlsArray);
  }
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
