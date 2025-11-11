import { BigNumber } from 'ethers';
import { formatEther, parseEther } from 'ethers/lib/utils.js';

import { HyperlaneIgp } from '@hyperlane-xyz/sdk';
import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

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
    .default('force', false);
}

const ReclaimStatus = {
  SUCCESS: 'SUCCESS',
  BELOW_THRESHOLD: 'BELOW_THRESHOLD',
  INSUFFICIENT_FOR_GAS: 'INSUFFICIENT_FOR_GAS',
  NO_GAS_PRICE: 'NO_GAS_PRICE',
  ERROR: 'ERROR',
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
  return num.toPrecision(5);
}

async function main() {
  const { environment, chains, force } = await withForce(withChains(getArgs()))
    .argv;
  const environmentConfig = getEnvironmentConfig(environment);

  // Get the IGP claim thresholds from the key funder config
  const keyFunderConfig = getKeyFunderConfig(environmentConfig);
  const igpClaimThresholds = keyFunderConfig.igpClaimThresholdPerChain;

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
      if (chainsToProcess.includes(chain)) {
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
        const thresholdStr = igpClaimThresholds[chain] || '0.1';
        const threshold = parseEther(thresholdStr);

        // Only reclaim when greater than the reclaim threshold (unless --force is used)
        if (!force && balance.lt(threshold)) {
          return {
            chain,
            balance: formatTo5SF(formattedBalance),
            threshold: formatTo5SF(thresholdStr),
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
            threshold: formatTo5SF(thresholdStr),
            status: ReclaimStatus.INSUFFICIENT_FOR_GAS,
          };
        }

        console.log(`Claiming from IGP on ${chain}...`);
        const tx = await paymaster.claim();
        const explorerUrl = multiProvider.tryGetExplorerTxUrl(chain, tx);
        console.log(`  ✓ ${explorerUrl || tx.hash}`);

        return {
          chain,
          balance: formatTo5SF(formattedBalance),
          threshold: formatTo5SF(thresholdStr),
          status: ReclaimStatus.SUCCESS,
        };
      } catch (error) {
        const provider = multiProvider.getProvider(chain);
        let balance = 'N/A';
        let thresholdStr = igpClaimThresholds[chain] || '0.1';
        try {
          const bal = await provider.getBalance(paymaster.address);
          balance = formatTo5SF(formatEther(bal));
        } catch {}

        const errorMsg = error instanceof Error ? error.message : String(error);
        // Extract just the key error info, not the full stack
        const shortError = errorMsg.split('\n')[0];
        console.log(`  ✗ ${chain}: ${shortError}`);
        return {
          chain,
          balance,
          threshold: formatTo5SF(thresholdStr),
          status: ReclaimStatus.ERROR,
        };
      }
    }),
  );

  // Convert to array and filter out nulls
  Object.values(reclaimResults).forEach((result) => {
    if (result) results.push(result);
  });

  // Only show chains with interesting statuses in the table
  const interestingResults = results.filter(
    (r) => r.status !== ReclaimStatus.BELOW_THRESHOLD,
  );

  if (interestingResults.length > 0) {
    console.log('\n=== Summary ===\n');
    const tableData = interestingResults.map((r) => ({
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

  console.log(`\n✓ Successfully claimed from ${successCount} chain(s)`);
  if (errorCount > 0) {
    console.log(`✗ ${errorCount} chain(s) encountered errors`);
  }
  if (belowThresholdCount > 0) {
    console.log(`- ${belowThresholdCount} chain(s) below threshold (skipped)`);
  }
  if (force) {
    console.log('\n(--force mode: bypassed threshold and gas checks)');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Fatal error:', error.message);
    process.exit(1);
  });
