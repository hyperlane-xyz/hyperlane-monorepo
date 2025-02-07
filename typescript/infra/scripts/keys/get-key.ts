import { getCloudAgentKey } from '../../src/agents/key-utils.js';
import {
  getArgs,
  withAgentRole,
  withContext,
  withProtocol,
} from '../agent-utils.js';
import { getConfigsBasedOnArgs } from '../core-utils.js';

async function main() {
  const argv = await withAgentRole(withContext(getArgs())).argv;

  const { agentConfig } = await getConfigsBasedOnArgs(argv);

  // As a (very rudimentary) security precaution, we don't print the private key directly to
  // the console if this script is ran directly.
  // We only write the private key to the console if it is not a tty, e.g. if
  // this is being called in a subshell or piped to another command.
  //
  // E.g. this will print the private key:
  //   $ echo `yarn tsx infra/scripts/keys/get-key.ts -e mainnet3 --role deployer`
  // or this too:
  //   $ echo $(yarn tsx infra/scripts/keys/get-key.ts -e mainnet3 --role deployer)
  // and even this:
  //   $ yarn tsx infra/scripts/keys/get-key.ts -e mainnet3 --role deployer | cat
  //
  // But this will not print the private key directly to the shell:
  //   $ yarn tsx infra/scripts/keys/get-key.ts -e mainnet3 --role deployer
  if (process.stdout.isTTY) {
    console.log('<omitted in tty, use in subshell>');
  } else {
    const key = getCloudAgentKey(agentConfig, argv.role);
    await key.fetch();
    console.log(key.privateKey);
  }
}

main().catch(console.error);
