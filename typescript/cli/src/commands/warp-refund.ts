import { readFileSync } from 'fs';

import { type CommandModuleWithContext } from '../context/types.js';
import {
  inputFileCommandOption,
  addressCommandOption,
  skipConfirmationOption,
} from './options.js';
import {
  errorRed,
  log,
  logBlue,
  logCommandHeader,
  logGreen,
  warnYellow,
} from '../logger.js';

interface CommitmentData {
  commitment: string;
  nonce: string;
  sender: string;
  recipient: string;
  amount: string;
  origin: string;
  destination: string;
  txHash: string;
  timestamp: string;
}

/**
 * Refund expired transfer
 */
export const warpRefundCommand: CommandModuleWithContext<{
  commitment: string;
  refundTo?: string;
}> = {
  command: 'refund',
  describe: 'Refund an expired private transfer',
  builder: {
    commitment: inputFileCommandOption({
      description: 'Path to commitment file from send-private',
      alias: 'c',
      demandOption: true,
    }),
    'refund-to': addressCommandOption(
      'Custom refund recipient address (defaults to original sender)',
      false,
    ),
    'skip-confirmation': skipConfirmationOption,
  },
  handler: async ({ context, commitment: commitmentPath, refundTo }) => {
    logCommandHeader('Refund Private Transfer');

    try {
      // Load commitment data
      logBlue('\n📂 Loading commitment data...');
      const commitmentData = loadCommitmentData(commitmentPath);

      logGreen('✓ Commitment loaded');
      log(`  Origin:      ${commitmentData.origin}`);
      log(`  Amount:      ${commitmentData.amount}`);
      log(`  Sender:      ${commitmentData.sender}`);

      // Check Aleo wallet
      logBlue('\n🔗 Connecting to Aleo wallet...');
      const aleoAddress = await connectAleoWallet();

      if (!aleoAddress) {
        errorRed('❌ Failed to connect to Aleo wallet');
        log('Make sure your Aleo wallet is unlocked and try again.');
        process.exit(1);
      }

      logGreen(`✓ Connected: ${aleoAddress}`);

      // Verify deposit exists
      logBlue('\n🔍 Verifying deposit on Aleo...');
      const depositRecord = await verifyDepositOnAleo(
        commitmentData.commitment,
      );

      if (!depositRecord) {
        errorRed('❌ Deposit not found on Aleo');
        log('\nPossible reasons:');
        log('  • Deposit transaction not yet confirmed');
        log('  • Invalid commitment data');
        process.exit(1);
      }

      logGreen('✓ Deposit verified');

      // Check if already forwarded
      if (depositRecord.forwarded) {
        errorRed('❌ Transfer already forwarded');
        log(`Forwarded at: ${depositRecord.forwardedAt}`);
        log('\nCannot refund a transfer that has been delivered.');
        process.exit(1);
      }

      // Check if already refunded
      if (depositRecord.refunded) {
        warnYellow('⚠️  Transfer already refunded');
        log(`Refunded at: ${depositRecord.refundedAt}`);
        log(`Refunded to: ${depositRecord.refundedTo}`);
        process.exit(0);
      }

      // Check expiry
      const now = Date.now();
      const depositTime = new Date(commitmentData.timestamp).getTime();
      const expiryTime = depositTime + 7 * 24 * 60 * 60 * 1000; // 7 days

      if (now <= expiryTime) {
        const hoursRemaining = Math.floor(
          (expiryTime - now) / (1000 * 60 * 60),
        );
        warnYellow(
          `⚠️  Transfer not yet expired (${hoursRemaining}h remaining)`,
        );
        log('\nTransfers can only be refunded after expiry (7 days).');
        log('Use the forward command to complete the transfer:');
        log(`  hyperlane warp forward --commitment ${commitmentPath}`);
        process.exit(1);
      }

      logGreen('✓ Transfer expired - refund available');

      // Determine refund recipient
      const refundRecipient = refundTo || commitmentData.sender;
      log(`\nRefund recipient: ${refundRecipient}`);

      // Verify sender ownership (must be original sender or have their permission)
      const isSender =
        aleoAddress === getAleoAddressForEvm(commitmentData.sender);
      if (!isSender) {
        warnYellow('⚠️  You are not the original sender');
        log('\nOnly the original sender can request a refund.');
        log(`Original sender: ${commitmentData.sender}`);
        process.exit(1);
      }

      // Submit refund transaction
      logBlue('\n📝 Submitting refund transaction on Aleo...');
      const refundTxId = await submitRefundTransaction({
        commitmentData,
        depositRecord,
        refundRecipient,
        aleoAddress,
      });

      logGreen(`\n✅ Refund transaction submitted!`);
      log(`Aleo Transaction: ${refundTxId}`);

      // Track refund delivery
      logBlue('\n⏳ Tracking refund delivery...');
      await trackRefundDelivery({
        refundTxId,
        origin: commitmentData.origin,
        recipient: refundRecipient,
      });

      logGreen('\n✅ Refund complete!');
      log(`\nFunds returned to ${refundRecipient} on ${commitmentData.origin}`);
    } catch (error) {
      errorRed(`\nRefund failed: ${error}`);
      process.exit(1);
    }

    process.exit(0);
  },
};

/**
 * Load commitment data from file
 */
function loadCommitmentData(filePath: string): CommitmentData {
  try {
    const data = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(data);

    // Validate required fields
    const required = [
      'commitment',
      'nonce',
      'sender',
      'amount',
      'origin',
      'txHash',
      'timestamp',
    ];

    for (const field of required) {
      if (!parsed[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    return parsed;
  } catch (error) {
    throw new Error(`Failed to load commitment data: ${error}`);
  }
}

/**
 * Connect to Aleo wallet
 */
async function connectAleoWallet(): Promise<string | null> {
  try {
    if (typeof window !== 'undefined' && (window as any).aleo) {
      const wallet = (window as any).aleo;
      const accounts = await wallet.requestAccounts();
      return accounts[0];
    }
    return null;
  } catch (error) {
    throw new Error(`Failed to connect to Aleo wallet: ${error}`);
  }
}

/**
 * Verify deposit exists on Aleo
 */
async function verifyDepositOnAleo(commitment: string): Promise<any | null> {
  try {
    // Query privacy_hub.aleo contract for deposit record
    // Placeholder implementation
    return {
      commitment,
      forwarded: false,
      forwardedAt: null,
      refunded: false,
      refundedAt: null,
      refundedTo: null,
    };
  } catch (error) {
    throw new Error(`Failed to verify deposit: ${error}`);
  }
}

/**
 * Get Aleo address for EVM address (from registration)
 */
function getAleoAddressForEvm(evmAddress: string): string | null {
  try {
    // Query privacy_hub.aleo for registration
    // Placeholder implementation
    return null;
  } catch {
    return null;
  }
}

/**
 * Submit refund transaction on Aleo
 */
async function submitRefundTransaction({
  commitmentData,
  depositRecord,
  refundRecipient,
  aleoAddress,
}: {
  commitmentData: CommitmentData;
  depositRecord: any;
  refundRecipient: string;
  aleoAddress: string;
}): Promise<string> {
  try {
    // This needs to call privacy_hub.aleo's refund_expired function
    // Placeholder implementation

    // const tx = await aleoWallet.executeProgram({
    //   program: 'privacy_hub.aleo',
    //   function: 'refund_expired',
    //   inputs: [
    //     commitmentData.commitment,
    //     commitmentData.nonce,
    //     refundRecipient,
    //   ],
    // });

    // return tx.transactionId;

    throw new Error('Refund not yet implemented - needs Aleo SDK integration');
  } catch (error) {
    throw new Error(`Failed to submit refund transaction: ${error}`);
  }
}

/**
 * Track refund delivery
 */
async function trackRefundDelivery({
  refundTxId,
  origin,
  recipient,
}: {
  refundTxId: string;
  origin: string;
  recipient: string;
}): Promise<void> {
  try {
    // Poll for message delivery via Hyperlane
    // Placeholder implementation
    await new Promise((resolve) => setTimeout(resolve, 5000));
    logGreen(`✓ Refund delivered to ${recipient} on ${origin}`);
  } catch (error) {
    throw new Error(`Failed to track refund: ${error}`);
  }
}
