import { confirm } from '@inquirer/prompts';

import { type CommandModuleWithWriteContext } from '../context/types.js';
import { chainCommandOption, skipConfirmationOption } from './options.js';
import {
  errorRed,
  log,
  logBlue,
  logCommandHeader,
  logGreen,
  warnYellow,
} from '../logger.js';

/**
 * Register user for privacy warp routes
 */
export const privacyRegisterCommand: CommandModuleWithWriteContext<{
  chain: string;
}> = {
  command: 'privacy-register',
  describe: 'Register your address for privacy warp routes',
  builder: {
    chain: {
      ...chainCommandOption,
      description: 'Chain to register from (EVM chain)',
      demandOption: true,
    },
    'skip-confirmation': skipConfirmationOption,
  },
  handler: async ({ context, chain, skipConfirmation }) => {
    logCommandHeader('Privacy Warp Route Registration');

    const { multiProvider, signer } = context;

    try {
      // Get signer address
      const signerAddress = await signer.getAddress();
      logBlue(`\nEVM Address: ${signerAddress}`);

      // Get Aleo address from wallet
      logBlue('\nConnecting to Aleo wallet...');
      const aleoAddress = await getAleoAddress();

      if (!aleoAddress) {
        errorRed('❌ Failed to get Aleo address');
        log('Make sure your Aleo wallet is unlocked and try again.');
        process.exit(1);
      }

      logGreen(`✓ Aleo Address: ${aleoAddress}`);

      // Check if already registered
      logBlue('\nChecking existing registration...');
      const existingRegistration =
        await checkExistingRegistration(signerAddress);

      if (existingRegistration) {
        warnYellow(
          `⚠️  Address already registered to: ${existingRegistration}`,
        );

        if (existingRegistration === aleoAddress) {
          logGreen('✓ Registration matches current Aleo address');
          process.exit(0);
        }

        const shouldContinue = await confirm({
          message: 'Re-register with new Aleo address?',
          default: false,
        });

        if (!shouldContinue) {
          log('Registration cancelled');
          process.exit(0);
        }
      }

      // Confirm registration
      if (!skipConfirmation) {
        log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log('\nRegistration Summary:');
        log(`  EVM Address:  ${signerAddress}`);
        log(`  Aleo Address: ${aleoAddress}`);
        log(`  Chain:        ${chain}`);
        log('\nThis will allow you to:');
        log('  • Send private transfers from any chain');
        log('  • Forward transfers on Aleo');
        log('  • Request refunds if needed');

        const shouldProceed = await confirm({
          message: '\nProceed with registration?',
          default: true,
        });

        if (!shouldProceed) {
          log('Registration cancelled');
          process.exit(0);
        }
      }

      // Submit registration transaction
      logBlue('\n📝 Submitting registration transaction...');
      const txHash = await submitRegistration({
        chain,
        evmAddress: signerAddress,
        aleoAddress,
        signer,
        multiProvider,
      });

      logGreen(`\n✅ Registration submitted!`);
      log(`Transaction: ${txHash}`);

      // Wait for confirmation
      logBlue('\n⏳ Waiting for confirmation...');
      await waitForRegistrationConfirmation(txHash, chain, multiProvider);

      logGreen('\n✅ Registration complete!');
      log('\nYou can now:');
      log('  1. Send private transfers: hyperlane warp send-private');
      log('  2. Forward on Aleo: hyperlane warp forward');
    } catch (error) {
      errorRed(`\nRegistration failed: ${error}`);
      process.exit(1);
    }

    process.exit(0);
  },
};

/**
 * Get Aleo address from connected wallet
 */
async function getAleoAddress(): Promise<string | null> {
  try {
    // This needs actual Aleo wallet integration
    // Placeholder implementation
    if (typeof window !== 'undefined' && (window as any).aleo) {
      const wallet = (window as any).aleo;
      const account = await wallet.requestAccounts();
      return account[0];
    }
    return null;
  } catch (error) {
    throw new Error(`Failed to connect to Aleo wallet: ${error}`);
  }
}

/**
 * Check if address is already registered
 */
async function checkExistingRegistration(
  evmAddress: string,
): Promise<string | null> {
  try {
    // Query privacy_hub.aleo contract for existing registration
    // Placeholder implementation
    return null;
  } catch {
    return null;
  }
}

/**
 * Submit registration transaction
 */
async function submitRegistration({
  chain,
  evmAddress,
  aleoAddress,
  signer,
  multiProvider,
}: {
  chain: string;
  evmAddress: string;
  aleoAddress: string;
  signer: any;
  multiProvider: any;
}): Promise<string> {
  try {
    // This needs to call the HypPrivate contract's register function
    // Placeholder implementation

    // Get contract address
    // const router = await getPrivateRouter(chain, multiProvider);

    // Submit transaction
    // const tx = await router.register(aleoAddress);
    // const receipt = await tx.wait();

    // return receipt.transactionHash;

    throw new Error(
      'Registration not yet implemented - needs contract integration',
    );
  } catch (error) {
    throw new Error(`Failed to submit registration: ${error}`);
  }
}

/**
 * Wait for registration confirmation
 */
async function waitForRegistrationConfirmation(
  txHash: string,
  chain: string,
  multiProvider: any,
): Promise<void> {
  try {
    // Wait for transaction confirmation
    // Placeholder implementation
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } catch (error) {
    throw new Error(`Failed to confirm registration: ${error}`);
  }
}
