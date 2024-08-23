import { setAndVerifyRpcUrls } from '../../src/utils/rpcUrls.js';
import { getArgs, withChainRequired, withRpcUrls } from '../agent-utils.js';

async function main() {
  const { environment, chain } = await withChainRequired(getArgs()).argv;

  await setAndVerifyRpcUrls(environment, chain);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
