import { AccountConfig, InterchainAccount } from '@hyperlane-xyz/sdk';
import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { icas } from '../../config/environments/mainnet3/owners.js';
import { getArgs as getEnvArgs } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

function getArgs() {
  return getEnvArgs().option('ownerChain', {
    type: 'string',
    description: 'Origin chain where the Safe owner lives',
    default: 'ethereum',
  }).argv;
}

async function main() {
  const { environment, ownerChain } = await getArgs();
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const owner = config.owners[ownerChain].ownerOverrides?._safeAddress;
  if (!owner) {
    console.error(`No Safe owner found for ${ownerChain}`);
    process.exit(1);
  }

  console.log(`Safe owner on ${ownerChain}: ${owner}`);

  const { chainAddresses } = await getHyperlaneCore(environment, multiProvider);
  const ica = InterchainAccount.fromAddressesMap(chainAddresses, multiProvider);

  const ownerConfig: AccountConfig = {
    origin: ownerChain,
    owner: owner,
  };

  const mismatchedResults: Record<
    string,
    { Expected: Address; Actual: Address }
  > = {};
  for (const [chain, expectedAddress] of Object.entries(icas)) {
    const actualAccount = await ica.getAccount(chain, ownerConfig);
    if (!eqAddress(expectedAddress, actualAccount)) {
      mismatchedResults[chain] = {
        Expected: expectedAddress,
        Actual: actualAccount,
      };
    }
  }

  if (Object.keys(mismatchedResults).length > 0) {
    console.error('\nMismatched ICAs found:');
    console.table(mismatchedResults);
    process.exit(1);
  } else {
    console.log('✅ All ICAs match the expected addresses.');
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
