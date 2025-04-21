import chalk from 'chalk';
import { BigNumber } from 'ethers';
import { formatUnits, parseUnits } from 'ethers/lib/utils.js';
import yargs from 'yargs';

import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { Role } from '../../src/roles.js';
import { getEnvironmentConfig } from '../core-utils.js';

const VANGUARDS = [
  'vanguard0', // regular
  'vanguard1', // regular
  'vanguard2', // regular
  'vanguard3', // 5x gas cap
  'vanguard4', // 5x gas cap
  'vanguard5', // 10x gas cap
] as const;

type VanguardName = (typeof VANGUARDS)[number];
type VanguardBalance = {
  chain: string;
  vanguard: VanguardName;
  balance: string;
};

const TOKEN_DECIMALS = 18;
const MIN_FUNDING_AMOUNT = parseUnits('0.05', TOKEN_DECIMALS);

const VANGUARD_ENVIRONMENT = 'mainnet3';
const VANGUARD_ADDRESSES: Record<VanguardName, Address> = {
  vanguard0: '0xbe2e6b1ce045422a08a3662fffa3fc5f114efc3d',
  vanguard1: '0xdbcd22e5223f5d0040398e66dbb525308f27c655',
  vanguard2: '0x226b721316ea44aad50a10f4cc67fc30658ab4a9',
  vanguard3: '0xcdd728647ecd9d75413c9b780de303b1d1eb12a5',
  vanguard4: '0x5401627b69f317da9adf3d6e1e1214724ce49032',
  vanguard5: '0x6fd953d1cbdf3a79663b4238898147a6cf36d459',
};

const VANGUARD_NETWORKS = [
  'base',
  'arbitrum',
  'optimism',
  'ethereum',
  'bsc',
] as const;

const VANGUARD_FUNDING_CONFIGS: Record<
  (typeof VANGUARD_NETWORKS)[number],
  Record<VanguardName, string>
> = {
  base: {
    vanguard0: '1', // 1x gas cap
    vanguard1: '1', // 1x gas cap
    vanguard2: '1', // 1x gas cap
    vanguard3: '1', // 5x gas cap
    vanguard4: '1', // 5x gas cap
    vanguard5: '1', // 10x gas cap
  },
  arbitrum: {
    vanguard0: '1', // 1x gas cap
    vanguard1: '1', // 1x gas cap
    vanguard2: '1', // 1x gas cap
    vanguard3: '1', // 5x gas cap
    vanguard4: '1', // 5x gas cap
    vanguard5: '1', // 10x gas cap
  },
  optimism: {
    vanguard0: '1', // 1x gas cap
    vanguard1: '1', // 1x gas cap
    vanguard2: '1', // 1x gas cap
    vanguard3: '1', // 5x gas cap
    vanguard4: '1', // 5x gas cap
    vanguard5: '1', // 10x gas cap
  },
  ethereum: {
    vanguard0: '5', // 1x gas cap
    vanguard1: '5', // 1x gas cap
    vanguard2: '5', // 1x gas cap
    vanguard3: '5', // 5x gas cap
    vanguard4: '5', // 5x gas cap
    vanguard5: '5', // 10x gas cap
  },
  bsc: {
    vanguard0: '10', // 1x gas cap
    vanguard1: '10', // 1x gas cap
    vanguard2: '5', // 1x gas cap
    vanguard3: '5', // 5x gas cap
    vanguard4: '5', // 5x gas cap
    vanguard5: '5', // 10x gas cap
  },
} as const;

async function fundVanguards() {
  const { fund } = await yargs(process.argv.slice(2))
    .describe('fund', 'Fund vanguards')
    .boolean('fund')
    .default('fund', false).argv;

  const envConfig = getEnvironmentConfig(VANGUARD_ENVIRONMENT);
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
  );

  // Print balances before funding
  const initialBalances: ChainMap<Record<string, string>> = {};
  for (const chain of VANGUARD_NETWORKS) {
    initialBalances[chain] = {};
    for (const vanguard of VANGUARDS) {
      const address = VANGUARD_ADDRESSES[vanguard];
      const provider = multiProvider.getProvider(chain);
      const currentBalance = await provider.getBalance(address);
      initialBalances[chain][vanguard] = Number(
        formatUnits(currentBalance, TOKEN_DECIMALS),
      ).toFixed(3); // Round to 3 decimal places
    }
  }

  rootLogger.info('\nInitial balances:');
  // eslint-disable-next-line no-console
  console.table(initialBalances);

  // Track which vanguards were topped up
  const topUpsNeeded: ChainMap<VanguardBalance[]> = {};

  await Promise.all(
    VANGUARD_NETWORKS.map(async (chain) => {
      for (const vanguard of VANGUARDS) {
        const address = VANGUARD_ADDRESSES[vanguard];
        try {
          const provider = multiProvider.getProvider(chain);
          const currentBalance = await provider.getBalance(address);
          const desiredBalance = parseUnits(
            VANGUARD_FUNDING_CONFIGS[chain][vanguard],
            TOKEN_DECIMALS,
          );
          const delta = desiredBalance.sub(currentBalance);

          if (delta.gt(MIN_FUNDING_AMOUNT)) {
            topUpsNeeded[chain] = topUpsNeeded[chain] || [];
            topUpsNeeded[chain].push({
              chain,
              vanguard,
              balance: Number(formatUnits(delta, TOKEN_DECIMALS)).toFixed(3),
            });
          }
        } catch (error) {
          rootLogger.error(
            chalk.bold.red(
              `Error topping up ${vanguard} on chain ${chain}:`,
              error,
            ),
          );
        }
      }
    }),
  );

  // Print summary of topped up vanguards
  if (Object.keys(topUpsNeeded).length > 0) {
    rootLogger.info('\nTop ups needed for the following:');
    // eslint-disable-next-line no-console
    console.table(
      Object.entries(topUpsNeeded).reduce((acc, [chain, topUps]) => {
        const chainEntries: Record<VanguardName, string> = {} as Record<
          VanguardName,
          string
        >;
        VANGUARDS.forEach((vanguard) => {
          const match = topUps.find((t) => t.vanguard === vanguard);
          chainEntries[vanguard] = match ? match.balance : '-';
        });
        acc[chain] = chainEntries;
        return acc;
      }, {} as Record<string, Record<VanguardName, string>>),
    );

    if (fund) {
      rootLogger.info(chalk.italic.blue('\nFunding vanguards...'));
    } else {
      rootLogger.info(chalk.italic.yellow('\nDry run - not funding vanguards'));
      return;
    }

    await Promise.all(
      Object.entries(topUpsNeeded).map(([chain, topUps]) =>
        topUps.map(async ({ vanguard, balance }) => {
          try {
            const signer = multiProvider.getSigner(chain);
            const signerBalance = await signer.getBalance();
            const amount = BigNumber.from(balance);

            if (signerBalance.lt(amount)) {
              rootLogger.warn(
                chalk.bold.yellow(
                  `Insufficient balance for ${vanguard} on ${chain}. Required: ${formatUnits(
                    amount,
                    TOKEN_DECIMALS,
                  )}, Available: ${formatUnits(signerBalance, TOKEN_DECIMALS)}`,
                ),
              );
              return;
            }

            return multiProvider.sendTransaction(chain, {
              to: VANGUARD_ADDRESSES[`${vanguard}`],
              value: amount,
            });
          } catch (error) {
            rootLogger.error(
              chalk.bold.red(
                `Error checking balance for ${vanguard} on ${chain}:`,
                error,
              ),
            );
            return;
          }
        }),
      ),
    );
  } else {
    rootLogger.info(chalk.bold.green('\nNo vanguards needed topping up'));
  }
}

fundVanguards().catch((error) => {
  rootLogger.error(chalk.bold.red('Error funding agents:', error));
  process.exit(1);
});
