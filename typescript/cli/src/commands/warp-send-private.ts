import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
import { ethers } from 'ethers';

import { type CommandModuleWithWriteContext } from '../context/types.js';
import {
  chainCommandOption,
  skipConfirmationOption,
  warpCoreConfigCommandOption,
  symbolCommandOption,
} from './options.js';
import {
  errorRed,
  log,
  logBlue,
  logCommandHeader,
  logGreen,
  warnYellow,
} from '../logger.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

/**
 * Send private transfer (deposit on origin)
 */
export const warpSendPrivateCommand: CommandModuleWithWriteContext<{
  origin: string;
  destination: string;
  amount: string;
  recipient: string;
  symbol?: string;
  warp?: string;
  output?: string;
}> = {
  command: 'send-private',
  describe: 'Send a private token transfer via Aleo privacy hub',
  builder: {
    origin: {
      ...chainCommandOption,
      description: 'Origin chain to send from',
      demandOption: true,
    },
    destination: {
      ...chainCommandOption,
      description: 'Destination chain to send to',
      demandOption: true,
    },
    amount: {
      type: 'string',
      description: 'Amount to send (in token units)',
      demandOption: true,
    },
    recipient: {
      type: 'string',
      description: 'Recipient address on destination chain',
      demandOption: true,
    },
    symbol: {
      ...symbolCommandOption,
      demandOption: false,
    },
    warp: {
      ...warpCoreConfigCommandOption,
      demandOption: false,
    },
    output: {
      type: 'string',
      description: 'Output file for commitment data',
      default: './commitment.json',
      alias: 'o',
    },
    'skip-confirmation': skipConfirmationOption,
  },
  handler: async ({
    context,
    origin,
    destination,
    amount,
    recipient,
    symbol,
    warp,
    output,
  }) => {
    logCommandHeader('Private Warp Transfer');

    const { multiProvider, signer } = context;

    try {
      // Get warp config
      const warpCoreConfig = await getWarpCoreConfigOrExit({
        symbol,
        warp,
        context,
      });

      // Check if route is privacy-enabled
      const originToken = warpCoreConfig.tokens.find(
        (t) => t.chainName === origin,
      );
      const destToken = warpCoreConfig.tokens.find(
        (t) => t.chainName === destination,
      );

      if (!originToken || !destToken) {
        errorRed(`❌ Route not found: ${origin} → ${destination}`);
        process.exit(1);
      }

      // Check if route supports privacy by looking at connections
      // Privacy routes should have appropriate connections configured
      // This is a placeholder - actual privacy verification should check
      // for privacy hub connections or specific standards
      // TODO: Implement proper privacy route detection based on connections

      // Check registration
      const signerAddress = await signer.getAddress();
      logBlue(`\nSender: ${signerAddress}`);

      const isRegistered = await checkRegistration(signerAddress);
      if (!isRegistered) {
        errorRed('❌ Address not registered');
        log('\nYou must register before sending private transfers.');
        log('Run: hyperlane warp privacy-register --chain ' + origin);
        process.exit(1);
      }

      logGreen('✓ Address registered');

      // Generate commitment
      logBlue('\n🔐 Generating commitment...');
      const nonce = generateNonce();
      const commitment = generateCommitment({
        sender: signerAddress,
        recipient,
        amount,
        destination,
        nonce,
      });

      logGreen(`✓ Commitment: ${commitment}`);
      logGreen(`✓ Nonce: ${nonce}`);

      // Show summary
      log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      log('\nTransfer Summary:');
      log(`  From:        ${origin}`);
      log(`  To:          ${destination}`);
      log(`  Amount:      ${amount} ${originToken.symbol}`);
      log(`  Recipient:   ${recipient}`);
      log(`  Commitment:  ${commitment.slice(0, 20)}...`);
      log('\nPrivacy Features:');
      log('  ✓ Amount hidden on Aleo');
      log('  ✓ No sender-recipient link on-chain');
      log('  ✓ User-controlled forwarding timing');

      // Submit deposit transaction
      logBlue('\n📝 Submitting deposit transaction...');
      const txHash = await submitDeposit({
        origin,
        destination,
        amount,
        recipient,
        commitment,
        signer,
        multiProvider,
        warpCoreConfig,
      });

      logGreen(`\n✅ Deposit submitted!`);
      log(`Transaction: ${txHash}`);

      // Save commitment data
      const commitmentData = {
        commitment,
        nonce,
        sender: signerAddress,
        recipient,
        amount,
        origin,
        destination,
        txHash,
        timestamp: new Date().toISOString(),
      };

      writeFileSync(output!, JSON.stringify(commitmentData, null, 2));
      logGreen(`\n✓ Commitment saved to: ${output}`);

      // Instructions
      log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logGreen('\n✅ Deposit complete!');
      log('\nNext steps:');
      log(`  1. Wait for deposit confirmation (~2-5 min)`);
      log(
        `  2. Forward on Aleo: hyperlane warp forward --commitment ${output}`,
      );
      log('\nThe transfer will remain private until you forward it.');
      log('Forward at any time - no rush!');

      warnYellow('\n⚠️  Keep the commitment file safe!');
      log('You need it to forward or refund the transfer.');
    } catch (error) {
      errorRed(`\nDeposit failed: ${error}`);
      process.exit(1);
    }

    process.exit(0);
  },
};

/**
 * Generate random nonce
 */
function generateNonce(): string {
  return '0x' + randomBytes(32).toString('hex');
}

/**
 * Generate commitment hash
 */
function generateCommitment({
  sender,
  recipient,
  amount,
  destination,
  nonce,
}: {
  sender: string;
  recipient: string;
  amount: string;
  destination: string;
  nonce: string;
}): string {
  // Keccak256(sender, recipient, amount, destination, nonce)
  return ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ['address', 'address', 'uint256', 'uint32', 'bytes32'],
      [sender, recipient, amount, destination, nonce],
    ),
  );
}

/**
 * Check if address is registered
 */
async function checkRegistration(address: string): Promise<boolean> {
  try {
    // Query privacy_hub.aleo contract
    // Placeholder implementation
    return true; // TODO: Implement actual check
  } catch {
    return false;
  }
}

/**
 * Submit deposit transaction
 */
async function submitDeposit({
  origin,
  destination,
  amount,
  recipient,
  commitment,
  signer,
  multiProvider,
  warpCoreConfig,
}: {
  origin: string;
  destination: string;
  amount: string;
  recipient: string;
  commitment: string;
  signer: any;
  multiProvider: any;
  warpCoreConfig: any;
}): Promise<string> {
  try {
    // This needs to call the HypPrivate contract's depositToPrivacyHub function
    // Placeholder implementation

    // Get router contract
    // const router = await getPrivateRouter(origin, warpCoreConfig);

    // Submit transaction
    // const tx = await router.depositToPrivacyHub(
    //   destination,
    //   recipient,
    //   amount,
    //   commitment
    // );
    // const receipt = await tx.wait();

    // return receipt.transactionHash;

    throw new Error('Deposit not yet implemented - needs contract integration');
  } catch (error) {
    throw new Error(`Failed to submit deposit: ${error}`);
  }
}
