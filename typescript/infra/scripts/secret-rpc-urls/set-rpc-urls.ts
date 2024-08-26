import { setAndVerifyRpcUrls } from '../../src/utils/rpcUrls.js';
import { getArgs, withChainRequired, withRpcUrls } from '../agent-utils.js';

async function main() {
  const { environment, chain, rpcUrls } = await withRpcUrls(
    withChainRequired(getArgs()),
  ).argv;

  const rpcUrlsArray = rpcUrls
    .split(/,\s*/)
    .filter(Boolean) // filter out empty strings
    .map((url) => url.trim());

  if (!rpcUrlsArray.length) {
    console.error('No rpc urls provided, Exiting.');
    process.exit(1);
  }

  await setAndVerifyRpcUrls(environment, chain, rpcUrlsArray);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
