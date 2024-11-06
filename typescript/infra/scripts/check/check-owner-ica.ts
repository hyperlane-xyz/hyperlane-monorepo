import { ethers } from 'ethers';

import { AccountConfig, InterchainAccount } from '@hyperlane-xyz/sdk';
import {
  Address,
  eqAddress,
  isZeroish,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { icas } from '../../config/environments/mainnet3/owners.js';
import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs as getEnvArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

function getArgs() {
  return withChains(getEnvArgs()).option('ownerChain', {
    type: 'string',
    description: 'Origin chain where the Safe owner lives',
    default: 'ethereum',
  }).argv;
}

async function main() {
  const { environment, ownerChain, chains } = await getArgs();
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

  const checkOwnerIcaChains = (
    chains?.length ? chains : Object.keys(icas)
  ).filter(isEthereumProtocolChain);

  const ownerConfig: AccountConfig = {
    origin: ownerChain,
    owner: owner,
  };
  const ownerChainInterchainAccountRouter =
    ica.contractsMap[ownerChain].interchainAccountRouter.address;

  if (isZeroishAddress(ownerChainInterchainAccountRouter)) {
    console.error(`Interchain account router address is zero`);
    process.exit(1);
  }

  const mismatchedResults: Record<
    string,
    { Expected: Address; Actual: Address }
  > = {};
  for (const chain of checkOwnerIcaChains) {
    const expectedAddress = icas[chain as keyof typeof icas];
    if (!expectedAddress) {
      console.error(`No expected address found for ${chain}`);
      continue;
    }
    const actualAccount = await ica.getAccount(
      chain,
      ownerConfig,
      ownerChainInterchainAccountRouter,
    );
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
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
