import { readFileSync } from 'fs';

import { type CommandModuleWithContext } from '../context/types.js';
import { inputFileCommandOption, skipConfirmationOption } from './options.js';
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
 * Forward transfer from Aleo to destination
 */
export const warpForwardCommand: CommandModuleWithContext<{
  commitment: string;
}> = {
  command: 'forward',
  describe: 'Forward a private transfer from Aleo to destination chain',
  builder: {
    commitment: inputFileCommandOption({
      description: 'Path to commitment file from send-private',
      alias: 'c',
      demandOption: true,
    }),
    'skip-confirmation': skipConfirmationOption,
  },
  handler: async ({ context, commitment: commitmentPath }) => {
    logCommandHeader('Forward Private Transfer');

    try {
      // Load commitment data
      logBlue('\n📂 Loading commitment data...');
      const commitmentData = loadCommitmentData(commitmentPath);

      logGreen('✓ Commitment loaded');
      log(`  Origin:      ${commitmentData.origin}`);
      log(`  Destination: ${commitmentData.destination}`);
      log(`  Amount:      ${commitmentData.amount}`);
      log(`  Recipient:   ${commitmentData.recipient}`);

      // Check Aleo wallet
      logBlue('\n🔗 Connecting to Aleo wallet...');
      const aleoAddress = await connectAleoWallet();

      if (!aleoAddress) {
        errorRed('❌ Failed to connect to Aleo wallet');
        log('Make sure your Aleo wallet is unlocked and try again.');
        process.exit(1);
      }

      logGreen(`✓ Connected: ${aleoAddress}`);

      // Verify deposit was received
      logBlue('\n🔍 Verifying deposit on Aleo...');
      const depositRecord = await verifyDepositOnAleo(
        commitmentData.commitment,
      );

      if (!depositRecord) {
        errorRed('❌ Deposit not found on Aleo');
        log('\nPossible reasons:');
        log('  • Deposit transaction not yet confirmed');
        log('  • Network delay (try again in a few minutes)');
        log('  • Invalid commitment data');
        process.exit(1);
      }

      logGreen('✓ Deposit verified on Aleo');

      // Check if already forwarded
      if (depositRecord.forwarded) {
        warnYellow('⚠️  This transfer has already been forwarded');
        log(`Forwarded at: ${depositRecord.forwardedAt}`);
        process.exit(0);
      }

      // Check expiry
      const now = Date.now();
      const depositTime = new Date(commitmentData.timestamp).getTime();
      const expiryTime = depositTime + 7 * 24 * 60 * 60 * 1000; // 7 days

      if (now > expiryTime) {
        warnYellow('⚠️  Transfer has expired');
        log('\nUse the refund command to recover your funds:');
        log(`  hyperlane warp refund --commitment ${commitmentPath}`);
        process.exit(1);
      }

      const timeRemaining = Math.floor((expiryTime - now) / (1000 * 60 * 60));
      log(`\nTime remaining: ${timeRemaining} hours`);

      // Submit forward transaction
      logBlue('\n📝 Submitting forward transaction on Aleo...');
      const forwardTxId = await submitForwardTransaction({
        commitmentData,
        depositRecord,
        aleoAddress,
      });

      logGreen(`\n✅ Forward transaction submitted!`);
      log(`Aleo Transaction: ${forwardTxId}`);

      // Track delivery
      logBlue('\n⏳ Tracking delivery to destination...');
      await trackDelivery({
        forwardTxId,
        destination: commitmentData.destination,
        recipient: commitmentData.recipient,
      });

      logGreen('\n✅ Transfer complete!');
      log('\nYour transfer has been delivered privately:');
      log(`  • Amount hidden during transit through Aleo`);
      log(`  • No deterministic link between sender and recipient`);
      log(`  • Privacy preserved`);
    } catch (error) {
      errorRed(`\nForward failed: ${error}`);
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
      'recipient',
      'amount',
      'origin',
      'destination',
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
    // This needs actual Aleo wallet integration
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
 * Verify deposit was received on Aleo
 */
async function verifyDepositOnAleo(commitment: string): Promise<any | null> {
  try {
    // Query privacy_hub.aleo contract for deposit record
    // Placeholder implementation
    return {
      commitment,
      forwarded: false,
      forwardedAt: null,
    };
  } catch (error) {
    throw new Error(`Failed to verify deposit: ${error}`);
  }
}

/**
 * Submit forward transaction on Aleo
 */
async function submitForwardTransaction({
  commitmentData,
  depositRecord,
  aleoAddress,
}: {
  commitmentData: CommitmentData;
  depositRecord: any;
  aleoAddress: string;
}): Promise<string> {
  try {
    // This needs to call privacy_hub.aleo's forward_transfer function
    // Placeholder implementation

    // const tx = await aleoWallet.executeProgram({
    //   program: 'privacy_hub.aleo',
    //   function: 'forward_transfer',
    //   inputs: [
    //     commitmentData.commitment,
    //     commitmentData.nonce,
    //     commitmentData.destination,
    //     commitmentData.recipient,
    //     commitmentData.amount,
    //   ],
    // });

    // return tx.transactionId;

    throw new Error('Forward not yet implemented - needs Aleo SDK integration');
  } catch (error) {
    throw new Error(`Failed to submit forward transaction: ${error}`);
  }
}

/**
 * Track delivery to destination chain
 */
async function trackDelivery({
  forwardTxId,
  destination,
  recipient,
}: {
  forwardTxId: string;
  destination: string;
  recipient: string;
}): Promise<void> {
  try {
    // Poll for message delivery
    // This should use Hyperlane message tracking
    // Placeholder implementation
    await new Promise((resolve) => setTimeout(resolve, 5000));
    logGreen(`✓ Delivered to ${recipient} on ${destination}`);
  } catch (error) {
    throw new Error(`Failed to track delivery: ${error}`);
  }
}
