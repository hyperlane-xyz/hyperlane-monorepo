import { HyperlaneCore, moduleCanCertainlyVerify } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { deployEnvToSdkEnv } from '../src/config/environment.js';

import { getArgs } from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';

async function main() {
  const args = await getArgs().argv;

  const { environment } = args;

  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );

  for (const local of core.chains()) {
    if (
      multiProvider.getChainMetadata(local).protocol !== ProtocolType.Ethereum
    ) {
      continue;
    }

    let ismToCheck = '';
    if (environment === 'testnet4' || environment === 'mainnet3') {
      ismToCheck = await core.getContracts(local).mailbox.defaultIsm();
    } else {
      throw new Error(`Unsupported environment ${environment}`);
    }

    const remotes = multiProvider.getRemoteChains(local);
    for (const remote of remotes) {
      console.log(`Checking chain ${local} can receive from ${remote}...`);
      const canVerify = await moduleCanCertainlyVerify(
        ismToCheck,
        multiProvider,
        remote,
        local,
      );
      if (canVerify) {
        console.log('All good!');
      } else {
        console.error(`Chain ${local} cannot receive from ${remote}!!!!`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
