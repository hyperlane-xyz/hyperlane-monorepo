import {
  getSecretRpcEndpoints,
  secretRpcEndpointsExist,
} from '../../src/agents/index.js';
import { getArgs, withChainRequired } from '../agent-utils.js';

async function main() {
  const { environment, chain } = await withChainRequired(getArgs()).argv;
  const secretExists = await secretRpcEndpointsExist(environment, chain);
  if (!secretExists) {
    console.log(
      `No secret rpc urls found for ${chain} in ${environment} environment`,
    );
    process.exit(0);
  }

  const secrets = await getSecretRpcEndpoints(environment, chain);
  console.log(secrets);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
