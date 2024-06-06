import {
  getSecretRpcEndpoints,
  secretRcpEndpointsExist,
} from '../../src/agents/index.js';
import { getArgs, withChain } from '../agent-utils.js';

async function main() {
  const { environment, chain } = await withChain(getArgs()).argv;

  try {
    const secretExists = await secretRcpEndpointsExist(environment, chain);
    if (!secretExists) {
      console.log(
        `No secret rpc urls found for ${chain} in ${environment} environment`,
      );
      process.exit(0);
    }

    const secrets = await getSecretRpcEndpoints(environment, chain);
    console.log(secrets);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

main()
  .then()
  .catch(() => process.exit(1));
