import { BigNumber, ethers } from 'ethers';
import path from 'path';

import {
  IDefaultStakerRewards__factory,
  IERC20__factory,
  IVault__factory,
} from '@hyperlane-xyz/core';
import { getSafe, getSafeService } from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  retryAsync,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Contexts } from './typescript/infra/src/config/contexts.js';
import { DeployEnvironment } from './typescript/infra/src/config/environment.js';
import { Role } from './typescript/infra/src/roles.js';
import {
  decodeMultiSendData,
  getSafeAndService,
} from './typescript/infra/src/utils/safe.js';
import { getInfraPath, readJSONAtPath } from './typescript/infra/src/utils/utils.js';
import { getEnvironmentConfig } from './typescript/infra/scripts/core-utils.js';

const DEFAULT_STAKER_REWARDS_ADDRESS = ethers.utils.getAddress(
  '0x84852EB9acbE1869372f83ED853B185F6c2848Dc',
);

const REWARD_TOKEN_ADDRESS = ethers.utils.getAddress(
  '0x93A2Db22B7c736B341C32Ff666307F4a9ED910F5', // HYPER Token
);

// MultiSend contract address on Ethereum mainnet
const MULTISEND_ADDRESS = ethers.utils.getAddress(
  '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
);

// Delay between processing each Safe (in milliseconds)
const DELAY_BETWEEN_SAFES_MS = 5000; // 5 seconds between each Safe
const DELAY_AFTER_EXECUTION_MS = 10000; // 10 seconds after execution
const DELAY_AFTER_RATE_LIMIT_MS = 30000; // 30 seconds after rate limit error

// Failed Safe addresses to retry
const FAILED_SAFES = new Set([
  '0x59ed870997690f7476B973B21A2cD009E8D001E2',
  '0xa40b1aCbacC75E9A4A52C3698880CC52ccd4c80B',
  '0x3612d84D36B6d72e7358Eea737F353057272AE5d',
  '0xa53A0AA6d736F65eC37a7aaC4e6350A40669e3A6',
  '0x516ac804897a344cA3d53d279344110181eBD9F2',
  '0x8f838D7e7fFDb0389681eE776317FBF08b77C3A4',
  '0x58AFF314BDb566943c22C4ad9616791fb7f303Da',
  '0xddd18a4D814Df932b8EE1b65E4bab8cb9677ef24',
  '0x2fF31059d726D9EE714AbdB52fBc6E0D029A220e',
  '0x8db1024d74F547B1dCc268f064844d40c3A053a4',
].map(addr => addr.toLowerCase()));

interface PendingTransaction {
  safeTxHash: string;
  nonce: number | string;
  confirmations: any[];
  to: string;
  data: string | null;
  value: string;
  operation: number;
}

interface VerificationResult {
  isValid: boolean;
  reason?: string;
  details?: {
    claimTo: string;
    approveSpender: string;
    depositAmount: string;
    vaultAddress: string;
  };
}

function verifyClaimAndStakeBatch(
  pendingTx: PendingTransaction,
): VerificationResult {
  try {
    // Check we have data
    if (!pendingTx.data || pendingTx.data === '0x') {
      return {
        isValid: false,
        reason: 'Transaction has no data',
      };
    }

    // Check if it's a multiSend transaction
    const txTo = ethers.utils.getAddress(pendingTx.to);
    const multiSendAddr = ethers.utils.getAddress(MULTISEND_ADDRESS);

    if (txTo.toLowerCase() !== multiSendAddr.toLowerCase()) {
      return {
        isValid: false,
        reason: `Expected transaction to MultiSend contract (${MULTISEND_ADDRESS}), got ${pendingTx.to}`,
      };
    }

    // Check for delegatecall operation (operation = 1)
    if (pendingTx.operation !== 1) {
      return {
        isValid: false,
        reason: `Expected delegatecall operation (1), got ${pendingTx.operation}`,
      };
    }

    // Decode the multiSend data
    let transactions;
    try {
      transactions = decodeMultiSendData(pendingTx.data);
    } catch (error) {
      return {
        isValid: false,
        reason: `Failed to decode multiSend data: ${error}`,
      };
    }

    // Verify we have exactly 3 transactions
    if (transactions.length !== 3) {
      return {
        isValid: false,
        reason: `Expected 3 transactions in batch, found ${transactions.length}`,
      };
    }

    const [claimTx, approveTx, depositTx] = transactions;

    // 1. Verify claim transaction
    const claimInterface = IDefaultStakerRewards__factory.createInterface();
    if (
      ethers.utils.getAddress(claimTx.to) !== DEFAULT_STAKER_REWARDS_ADDRESS
    ) {
      return {
        isValid: false,
        reason: `First transaction should be to DefaultStakerRewards (${DEFAULT_STAKER_REWARDS_ADDRESS}), got ${claimTx.to}`,
      };
    }

    let claimData;
    try {
      claimData = claimInterface.decodeFunctionData(
        'claimRewards',
        claimTx.data,
      );
    } catch (error) {
      return {
        isValid: false,
        reason: `First transaction should be claimRewards call: ${error}`,
      };
    }

    // Handle both named and indexed access
    const claimRecipient = claimData.recipient || claimData[0];
    const claimToken = claimData.token || claimData[1];

    if (ethers.utils.getAddress(claimToken) !== REWARD_TOKEN_ADDRESS) {
      return {
        isValid: false,
        reason: `Claim should be for HYPER token (${REWARD_TOKEN_ADDRESS}), got ${claimToken}`,
      };
    }

    // 2. Verify approve transaction
    const tokenInterface = IERC20__factory.createInterface();
    if (ethers.utils.getAddress(approveTx.to) !== REWARD_TOKEN_ADDRESS) {
      return {
        isValid: false,
        reason: `Second transaction should be to HYPER token (${REWARD_TOKEN_ADDRESS}), got ${approveTx.to}`,
      };
    }

    let approveData;
    try {
      approveData = tokenInterface.decodeFunctionData(
        'approve',
        approveTx.data,
      );
    } catch (error) {
      return {
        isValid: false,
        reason: `Second transaction should be approve call: ${error}`,
      };
    }

    // Handle both named and indexed access
    const approveSpender = ethers.utils.getAddress(
      approveData.spender || approveData[0],
    );
    const approveAmount = BigNumber.from(
      approveData.amount || approveData.value || approveData[1],
    );

    // 3. Verify deposit transaction
    const vaultInterface = IVault__factory.createInterface();
    const depositTo = ethers.utils.getAddress(depositTx.to);

    if (depositTo !== approveSpender) {
      return {
        isValid: false,
        reason: `Third transaction should be to the vault (${approveSpender}), got ${depositTx.to}`,
      };
    }

    let depositData;
    try {
      depositData = vaultInterface.decodeFunctionData(
        'deposit',
        depositTx.data,
      );
    } catch (error) {
      return {
        isValid: false,
        reason: `Third transaction should be deposit call: ${error}`,
      };
    }

    const depositReceiver = depositData.receiver || depositData[0];
    const depositAmount = BigNumber.from(depositData.assets || depositData[1]);

    // Verify amounts match
    if (!approveAmount.eq(depositAmount)) {
      return {
        isValid: false,
        reason: `Approve amount (${approveAmount.toString()}) doesn't match deposit amount (${depositAmount.toString()})`,
      };
    }

    return {
      isValid: true,
      details: {
        claimTo: claimRecipient,
        approveSpender: approveSpender,
        depositAmount: ethers.utils.formatEther(depositAmount),
        vaultAddress: depositTx.to,
      },
    };
  } catch (error: any) {
    return {
      isValid: false,
      reason: `Verification failed: ${error.message || error}`,
    };
  }
}

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  // Parse command line arguments
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const skipVerification =
    args.includes('--skip-verification') || args.includes('--no-verify');

  if (dryRun) {
    rootLogger.info('🔍 DRY RUN MODE - No transactions will be executed\n');
  }

  if (skipVerification) {
    rootLogger.info(
      '⚠️  VERIFICATION SKIPPED - Transactions will NOT be verified\n',
    );
  }

  rootLogger.info(`🔄 RETRY MODE - Processing ${FAILED_SAFES.size} failed Safe(s)\n`);

  const environment = 'mainnet3' as DeployEnvironment;
  const chainName = 'ethereum';

  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    [chainName],
  );

  const deployerAddress = await multiProvider.getSigner(chainName).getAddress();
  rootLogger.info(`Using deployer address: ${deployerAddress}`);

  // Debug: Verify Safe API key is loaded
  const chainMetadata = multiProvider.getChainMetadata(chainName);
  const safeApiKey = chainMetadata.gnosisSafeApiKey;
  const safeTxServiceUrl = chainMetadata.gnosisSafeTransactionServiceUrl;
  rootLogger.info(`Safe TX Service URL: ${safeTxServiceUrl}`);
  rootLogger.info(
    `Safe API Key loaded: ${safeApiKey ? `YES (${safeApiKey.substring(0, 10)}...)` : 'NO - THIS IS THE PROBLEM!'}`,
  );
  rootLogger.info('');

  const multisigsPath = path.join(
    getInfraPath(),
    'config/environments/mainnet3/rewards/employeeMultisigs.json',
  );
  const multisigs = readJSONAtPath(multisigsPath) as Record<string, string>;

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;
  let processedCount = 0;

  const safeEntries = Object.entries(multisigs);

  // Filter to only failed Safes
  const failedEntries = safeEntries.filter(([_, address]) => 
    FAILED_SAFES.has(address.toLowerCase())
  );

  rootLogger.info(`Found ${failedEntries.length} failed Safe(s) to retry\n`);

  for (let i = 0; i < failedEntries.length; i++) {
    const [index, safeAddress] = failedEntries[i];

    // Add delay between Safes to avoid rate limiting (except for first processed one)
    if (processedCount > 0) {
      rootLogger.info(
        `\n⏳ Waiting ${DELAY_BETWEEN_SAFES_MS / 1000}s before processing next Safe to avoid rate limiting...`,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, DELAY_BETWEEN_SAFES_MS),
      );
    }

    processedCount++;

    rootLogger.info(`\n${'='.repeat(80)}`);
    rootLogger.info(`Processing Safe ${index}: ${safeAddress}`);
    rootLogger.info('='.repeat(80));

    try {
      // Get Safe service and SDK using the utility that handles API keys properly
      // Use retry with exponential backoff for rate limiting
      const { safeSdk, safeService } = await retryAsync(
        () => getSafeAndService(chainName, multiProvider, safeAddress),
        5,
        1000,
      );

      // Get Safe threshold
      const threshold = await safeSdk.getThreshold();
      rootLogger.info(`Safe threshold: ${threshold}`);

      // Get pending transactions with retry logic and exponential backoff
      const pendingTxs = await retryAsync(
        () => safeService.getPendingTransactions(safeAddress),
        5,
        1000,
      );

      if (pendingTxs.count === 0) {
        rootLogger.info('✓ No pending transactions found');
        skipCount++;
        continue;
      }

      rootLogger.info(`Found ${pendingTxs.count} pending transaction(s)\n`);

      // Process each pending transaction
      for (const tx of pendingTxs.results) {
        const confirmationsCount = tx.confirmations?.length ?? 0;
        rootLogger.info(`\nTransaction Hash: ${tx.safeTxHash}`);
        rootLogger.info(`Nonce: ${tx.nonce}`);
        rootLogger.info(`Confirmations: ${confirmationsCount}/${threshold}`);
        rootLogger.info(`To: ${tx.to}`);
        rootLogger.info(`Operation: ${tx.operation}`);

        // Check if transaction has enough confirmations
        if (confirmationsCount < threshold) {
          rootLogger.info(
            `⏸️  Skipping - Not enough confirmations (${confirmationsCount}/${threshold})\n`,
          );
          skipCount++;
          continue;
        }

        // Verify the transaction is a valid claim-and-stake batch (unless skipped)
        if (!skipVerification) {
          rootLogger.info('\n🔍 Verifying transaction structure...');
          const verification = verifyClaimAndStakeBatch(
            tx as PendingTransaction,
          );

          if (!verification.isValid) {
            rootLogger.warn(
              `⚠️  Transaction verification failed: ${verification.reason}`,
            );
            rootLogger.warn('Skipping this transaction\n');
            skipCount++;
            continue;
          }

          rootLogger.info(
            '✓ Transaction verified as valid claim-and-stake batch',
          );
          if (verification.details) {
            rootLogger.info(`  - Claim to: ${verification.details.claimTo}`);
            rootLogger.info(`  - Vault: ${verification.details.vaultAddress}`);
            rootLogger.info(
              `  - Amount: ${verification.details.depositAmount} HYPER`,
            );
          }
        } else {
          rootLogger.info(
            '\n⚠️  Skipping verification (--skip-verification flag set)',
          );
        }

        if (dryRun) {
          rootLogger.info('\n🔍 DRY RUN - Would execute this transaction');
          successCount++;
          continue;
        }

        // Execute the transaction
        rootLogger.info('\n🚀 Executing transaction...');
        try {
          // Fetch the full transaction from the service with retry
          const safeTxHash = tx.safeTxHash;
          const safeTransaction = await retryAsync(
            async () => {
              const fetchedTx = await safeService.getTransaction(safeTxHash);
              if (!fetchedTx) {
                throw new Error(
                  `Failed to fetch transaction details for ${safeTxHash}`,
                );
              }
              return fetchedTx;
            },
            5,
            2000,
          );

          // Check Safe balance for gas
          const balance = await multiProvider
            .getProvider(chainName)
            .getBalance(safeAddress);

          rootLogger.info(
            `Safe balance: ${ethers.utils.formatEther(balance)} ETH`,
          );

          // Execute the transaction with retry logic for rate limiting
          rootLogger.info('Submitting execution transaction to network...');
          const executeTxResponse = await retryAsync(
            async () => {
              return await safeSdk.executeTransaction(safeTransaction);
            },
            5,
            3000, // 3 second delay between retries
          );

          const txResponse = executeTxResponse.transactionResponse;

          if (!txResponse) {
            throw new Error('No transaction response returned from Safe SDK');
          }

          rootLogger.info('Waiting for transaction confirmation...');
          // Wait for transaction confirmation
          const receipt = await (txResponse as any).wait();

          if (receipt?.status === 1) {
            rootLogger.info(`✅ Transaction executed successfully!`);
            rootLogger.info(`   TX Hash: ${receipt.transactionHash}`);
            rootLogger.info(`   Gas Used: ${receipt.gasUsed.toString()}`);
            successCount++;
          } else {
            throw new Error(
              `Transaction failed with status: ${receipt?.status}`,
            );
          }

          // Wait after execution to ensure nonce is updated
          rootLogger.info(
            `\n⏳ Waiting ${DELAY_AFTER_EXECUTION_MS / 1000}s for transaction confirmation...`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, DELAY_AFTER_EXECUTION_MS),
          );
        } catch (execError: any) {
          rootLogger.error(`❌ Execution failed: ${execError.message}`);

          // Try to extract revert reason if available
          if (execError.reason) {
            rootLogger.error(`   Revert reason: ${execError.reason}`);
          }
          if (execError.error?.message) {
            rootLogger.error(`   Error details: ${execError.error.message}`);
          }

          errorCount++;
          rootLogger.info('Continuing to next Safe...\n');
        }
      }
    } catch (error: any) {
      rootLogger.error(
        `❌ Failed to process Safe ${safeAddress}: ${error.message}`,
      );
      if (error.stack) {
        rootLogger.debug(error.stack);
      }
      errorCount++;

      // If it's a rate limit error, add extra delay before continuing
      if (
        error.message?.includes('Too Many Requests') ||
        error.message?.includes('429')
      ) {
        rootLogger.warn(
          `⏳ Rate limited - waiting ${DELAY_AFTER_RATE_LIMIT_MS / 1000}s before continuing...`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, DELAY_AFTER_RATE_LIMIT_MS),
        );
      }

      rootLogger.info('Continuing to next Safe...\n');
    }
  }

  // Summary
  rootLogger.info('\n' + '='.repeat(80));
  rootLogger.info('RETRY EXECUTION SUMMARY');
  rootLogger.info('='.repeat(80));
  rootLogger.info(`✅ Successfully executed: ${successCount}`);
  rootLogger.info(`⏸️  Skipped: ${skipCount}`);
  rootLogger.info(`❌ Errors: ${errorCount}`);
  rootLogger.info(`📊 Total failed Safes attempted: ${failedEntries.length}`);

  if (dryRun) {
    rootLogger.info(
      '\n💡 This was a dry run. Use without --dry-run to execute transactions.',
    );
  }

  if (skipVerification && !dryRun) {
    rootLogger.info(
      '\n⚠️  Verification was skipped. Ensure transactions were verified in a previous dry run.',
    );
  }
}

main().catch((e) => {
  rootLogger.error(e);
  process.exit(1);
});
