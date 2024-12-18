import chalk from 'chalk';
import { ethers } from 'ethers';

import { AccountConfig, InterchainAccount } from '@hyperlane-xyz/sdk';
import {
  Address,
  LogFormat,
  LogLevel,
  assert,
  configureRootLogger,
  eqAddress,
  isZeroishAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import awIcas from '../../config/environments/mainnet3/aw-icas.json';
import { oldIcas } from '../../config/environments/mainnet3/owners.js';
import { chainsToSkip } from '../../src/config/chain.js';
import { IcaArtifact } from '../../src/config/icas.js';
import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs as getEnvArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

function getArgs() {
  return withChains(getEnvArgs())
    .option('ownerChain', {
      type: 'string',
      description: 'Origin chain where the Safe owner lives',
      default: 'ethereum',
    })
    .describe('legacy', 'If enabled, checks legacy ICAs')
    .boolean('legacy')
    .default('legacy', false).argv;
}

async function main() {
  const { environment, ownerChain, chains, legacy } = await getArgs();
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  assert(environment === 'mainnet3', 'Only mainnet3 is supported');

  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const ownerAddress = config.owners[ownerChain].ownerOverrides?._safeAddress;
  if (!ownerAddress) {
    rootLogger.error(chalk.bold.red(`No Safe owner found for ${ownerChain}`));
    process.exit(1);
  }

  rootLogger.info(`Safe owner on ${ownerChain}: ${ownerAddress}`);

  const { chainAddresses } = await getHyperlaneCore(environment, multiProvider);
  const ica = InterchainAccount.fromAddressesMap(chainAddresses, multiProvider);

  const checkOwnerIcaChains = (
    chains?.length ? chains : Object.keys(legacy ? oldIcas : awIcas)
  ).filter(
    (chain) => isEthereumProtocolChain(chain) && !chainsToSkip.includes(chain),
  );

  // Check that the interchain account router address is not zero
  const ownerChainInterchainAccountRouter =
    ica.contractsMap[ownerChain].interchainAccountRouter.address;
  if (isZeroishAddress(ownerChainInterchainAccountRouter)) {
    rootLogger.error(
      chalk.bold.red(`Interchain account router address is zero`),
    );
    process.exit(1);
  }

  // Create the owner config
  const ownerConfig: AccountConfig = {
    origin: ownerChain,
    owner: ownerAddress,
    routerOverride: ownerChainInterchainAccountRouter,
  };

  const expectedIcas: Record<string, IcaArtifact> = {};

  const mismatchedResults: Record<
    string,
    { Expected: Address; Actual: Address }
  > = {};
  for (const chain of checkOwnerIcaChains) {
    const expected = getExpectedIca(chain, legacy);
    expectedIcas[chain] = expected;

    if (!expected) {
      rootLogger.warn(chalk.yellow(`No expected address found for ${chain}`));
      continue;
    }

    if (isZeroishAddress(expected.ica)) {
      rootLogger.warn(chalk.yellow(`ICA address is zero for ${chain}`));
      continue;
    }

    const actualAccount = await ica.getAccount(chain, {
      ...ownerConfig,
      ismOverride: expected.ism,
    });
    if (!eqAddress(expected.ica, actualAccount)) {
      mismatchedResults[chain] = {
        Expected: expected.ica,
        Actual: actualAccount,
      };
    }
  }

  if (Object.keys(mismatchedResults).length > 0) {
    rootLogger.error(chalk.bold.red('\nMismatched ICAs found:'));
    console.table(mismatchedResults);
    process.exit(1);
  } else {
    rootLogger.info(
      chalk.bold.green('✅ All ICAs match the expected addresses.'),
    );
    console.table(expectedIcas);
  }
  process.exit(0);
}

// Enables support for checking legacy ICAs
function getExpectedIca(chain: string, legacy: boolean): IcaArtifact {
  return legacy
    ? {
        ica:
          oldIcas[chain as keyof typeof oldIcas] ||
          ethers.constants.AddressZero,
        ism: ethers.constants.AddressZero,
      }
    : awIcas[chain as keyof typeof awIcas];
}

main().catch((err) => {
  rootLogger.error('Error:', err);
  process.exit(1);
});
