import chalk from 'chalk';
import { formatEther, parseEther } from 'ethers/lib/utils.js';

import { HyperlaneIgp } from '@hyperlane-xyz/sdk';
import {
  isZeroishAddress,
  objMap,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { getEnvAddresses } from '../../config/registry.js';
import { getKeyFunderConfig } from '../../src/funding/key-funder.js';
import { TurnkeyRole } from '../../src/roles.js';
import { setTurnkeySignerForEvmChains } from '../../src/utils/turnkey.js';
import { getArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

function withForce<T>(args: any) {
  return args
    .describe('force', 'Force claim even if below threshold')
    .boolean('force')
    .alias('f', 'force')
    .default('force', false)
    .describe('dry-run', 'Perform all checks without executing claims')
    .boolean('dry-run')
    .default('dry-run', false);
}

const ReclaimStatus = {
  SUCCESS: '🟢',
  BELOW_THRESHOLD: '🔵',
  INSUFFICIENT_FOR_GAS: '🟡',
  NO_GAS_PRICE: '🟡',
  ERROR: '🔴',
} as const;
type ReclaimStatus = (typeof ReclaimStatus)[keyof typeof ReclaimStatus];

interface ReclaimResult {
  chain: string;
  balance: string;
  threshold: string;
  status: ReclaimStatus;
}

// Format to 5 significant figures
function formatTo5SF(value: string): string {
  const num = parseFloat(value);
  if (num === 0) return '0';
  if (isNaN(num)) return 'N/A';
  return num.toPrecision(5);
}

async function main() {
  const { environment, chains, force, dryRun } = await withForce(
    withChains(getArgs()),
  ).argv;
  const environmentConfig = getEnvironmentConfig(environment);

  // Get the IGP claim thresholds from the key funder config
  const keyFunderConfig = getKeyFunderConfig(environmentConfig);
  const igpClaimThresholds = keyFunderConfig.igpClaimThresholdPerChain ?? {};
  const desiredBalances = keyFunderConfig.desiredBalancePerChain;

  // Filter chains if provided
  const chainsToProcess = chains?.length
    ? chains
    : environmentConfig.supportedChainNames;

  const multiProvider = await environmentConfig.getMultiProvider(
    undefined,
    undefined,
    undefined,
    chainsToProcess,
  );

  // Set the Turnkey signer for only EVM chains in the multiProvider
  // Continue to use legacy deployer via turnkey for now
  // to avoid needing to fund the new key on all chains
  await setTurnkeySignerForEvmChains(
    multiProvider,
    environment,
    TurnkeyRole.EvmLegacyDeployer,
  );

  const igp = HyperlaneIgp.fromAddressesMap(
    getEnvAddresses(environment),
    multiProvider,
  );

  // Filter to only include chains we want to process
  const filteredPaymasters = objMap(
    igp.map((_, contracts) => contracts.interchainGasPaymaster),
    (chain, paymaster) => {
      if (
        chainsToProcess.includes(chain) &&
        !isZeroishAddress(paymaster.address)
      ) {
        return paymaster;
      }
      return undefined;
    },
  );

  const results: ReclaimResult[] = [];

  const reclaimResults = await promiseObjAll(
    objMap(filteredPaymasters, async (chain, paymaster) => {
      if (!paymaster) return null;

      try {
        const provider = multiProvider.getProvider(chain);
        const balance = await provider.getBalance(paymaster.address);
        const formattedBalance = formatEther(balance);

        // Get the threshold for this chain from config, default to 0.1 ETH if not set
        // Fallback to 1/5th of desired balance if no threshold configured, matching fund-keys-from-deployer.ts logic
        let threshold: bigint;
        const thresholdStr = igpClaimThresholds?.[chain];
        if (thresholdStr) {
          // igpClaimThresholds values are in ETH (e.g., '0.1'), need to parse as ether
          threshold = BigInt(parseEther(thresholdStr).toString());
        } else {
          // Use desired balance / 5 as fallback threshold if not explicitly set
          const desired = desiredBalances[chain];
          if (desired) {
            const fallback = parseEther(desired).div(5);
            threshold = BigInt(fallback.toString());
            rootLogger.debug(
              { chain },
              'Inferring IGP claim threshold from desired balance',
            );
          } else {
            // Default minimal fallback, e.g. 0.1 ETH
            threshold = BigInt(parseEther('0.1').toString());
            rootLogger.warn(
              { chain },
              'No IGP claim threshold or desired balance for chain, using default',
            );
          }
        }

        // Skip if balance is zero (even with --force)
        if (balance.isZero()) {
          return {
            chain,
            balance: formatTo5SF(formattedBalance),
            threshold: formatTo5SF(formatEther(threshold)),
            status: ReclaimStatus.BELOW_THRESHOLD,
          };
        }

        // Only reclaim when greater than the reclaim threshold (unless --force is used)
        if (!force && balance.lt(threshold)) {
          return {
            chain,
            balance: formatTo5SF(formattedBalance),
            threshold: formatTo5SF(formatEther(threshold)),
            status: ReclaimStatus.BELOW_THRESHOLD,
          };
        }

        // Estimate the gas cost for the claim transaction
        const gasEstimate = await paymaster.estimateGas.claim();
        const feeData = await provider.getFeeData();

        // Calculate total cost: gas * (gasPrice or maxFeePerGas)
        const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
        if (!gasPrice) {
          return {
            chain,
            balance: formatTo5SF(formattedBalance),
            threshold: formatTo5SF(thresholdStr),
            status: ReclaimStatus.NO_GAS_PRICE,
          };
        }

        const estimatedCost = gasEstimate.mul(gasPrice);
        const costThreshold = estimatedCost.mul(2); // 2x the cost

        // Only proceed if balance > 2x the estimated cost (unless --force is used)
        if (!force && balance.lte(costThreshold)) {
          return {
            chain,
            balance: formatTo5SF(formattedBalance),
            threshold: formatTo5SF(formatEther(threshold)),
            status: ReclaimStatus.INSUFFICIENT_FOR_GAS,
          };
        }

        rootLogger.debug(`Claiming from IGP on ${chain}...`);
        let tx;
        let explorerUrl;
        if (dryRun) {
          rootLogger.info(`[DRY RUN] Would claim from IGP on ${chain}`);
        } else {
          tx = await paymaster.claim();
          explorerUrl = multiProvider.tryGetExplorerTxUrl(chain, tx);
          rootLogger.info(
            `Claimed from IGP on ${chain}: ${explorerUrl || tx.hash}`,
          );
        }

        return {
          chain,
          balance: formatTo5SF(formattedBalance),
          threshold: formatTo5SF(formatEther(threshold)),
          status: ReclaimStatus.SUCCESS,
        };
      } catch (error) {
        const provider = multiProvider.getProvider(chain);
        let balance = 'N/A';
        let thresholdDisplay = '0.1';
        try {
          const bal = await provider.getBalance(paymaster.address);
          balance = formatTo5SF(formatEther(bal));
        } catch {}

        // Calculate threshold for display
        const thresholdStr = igpClaimThresholds?.[chain];
        if (thresholdStr) {
          thresholdDisplay = thresholdStr;
        } else {
          const desired = desiredBalances[chain];
          if (desired) {
            thresholdDisplay = formatEther(parseEther(desired).div(5));
          }
        }

        const errorMsg = error instanceof Error ? error.message : String(error);
        // Extract just the key error info, not the full stack
        const shortError = errorMsg.split('\n')[0];
        rootLogger.error(
          chalk.red(`Error claiming from IGP on ${chain}: ${shortError}`),
        );
        return {
          chain,
          balance,
          threshold: formatTo5SF(thresholdDisplay),
          status: ReclaimStatus.ERROR,
        };
      }
    }),
  );

  // Convert to array and filter out nulls
  const filteredResults = Object.values(reclaimResults).filter(
    (result): result is ReclaimResult =>
      result !== null && result !== undefined,
  );
  results.push(...filteredResults);

  // Show all chains in the table
  if (results.length > 0) {
    const tableData = results.map((r) => ({
      chain: r.chain,
      balance: r.balance,
      threshold: r.threshold,
      status: r.status,
    }));
    console.table(tableData);
  }

  const successCount = results.filter(
    (r) => r.status === ReclaimStatus.SUCCESS,
  ).length;
  const errorCount = results.filter(
    (r) => r.status === ReclaimStatus.ERROR,
  ).length;
  const belowThresholdCount = results.filter(
    (r) => r.status === ReclaimStatus.BELOW_THRESHOLD,
  ).length;

  rootLogger.info(
    chalk.green(`\nSuccessfully claimed from ${successCount} chain(s)`),
  );
  if (errorCount > 0) {
    rootLogger.error(
      chalk.red(
        `Encountered ${errorCount} errors on: ${results
          .filter((r) => r.status === ReclaimStatus.ERROR)
          .map((r) => r.chain)
          .join(', ')}`,
      ),
    );
  }
  if (belowThresholdCount > 0) {
    rootLogger.info(
      chalk.yellow(`${belowThresholdCount} chain(s) below threshold (skipped)`),
    );
  }
  if (dryRun) {
    rootLogger.info(
      chalk.cyan(
        '\n(--dry-run mode: no claims were executed, this was a simulation)',
      ),
    );
  }
  if (force) {
    rootLogger.info(
      chalk.yellow('\n(--force mode: bypassed threshold and gas checks)'),
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    rootLogger.error(chalk.red('Fatal error:', error.message));
    process.exit(1);
  });
