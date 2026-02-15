/**
 * Example usage of Privacy Warp Route adapters
 *
 * This file demonstrates the complete flow:
 * 1. User registration on Aleo
 * 2. Private deposit on origin chain
 * 3. Forward to destination via Aleo privacy hub
 * 4. Receive on destination chain
 */

import { ethers } from 'ethers';

import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';

import { AleoPrivacyHubAdapter } from './AleoPrivacyHubAdapter.js';
import {
  AleoWalletAdapter,
  EvmHypPrivateCollateralAdapter,
} from './PrivateWarpOriginAdapter.js';

// Example Aleo wallet adapter implementation
export class ExampleAleoWallet implements AleoWalletAdapter {
  constructor(_privateKey: string) {}

  async getAddress(): Promise<string> {
    // In production, use Leo Wallet or Puzzle Wallet SDK
    return 'aleo1...'; // Placeholder
  }

  async signMessage(_message: string): Promise<string> {
    // Sign with Aleo private key
    return 'signature'; // Placeholder
  }

  async signTransaction(_tx: any): Promise<string> {
    // Sign Aleo transaction
    return 'signed_tx'; // Placeholder
  }
}

/**
 * Step 1: Register user on Aleo privacy hub
 */
export async function registerUser(
  multiProvider: MultiProtocolProvider,
  originChain: string,
  originAddress: string,
  aleoWallet: AleoWalletAdapter,
): Promise<void> {
  // Create Aleo privacy hub adapter
  const aleoAdapter = new AleoPrivacyHubAdapter('aleo', multiProvider, {
    privacyHub: 'privacy_hub.aleo',
  });

  // Get origin chain domain
  const originDomain = multiProvider.getDomainId(originChain);

  // Check if already registered
  const addressBytes = addressToBytes32(originAddress);
  const addressArray = new Uint8Array(
    Buffer.from(addressBytes.slice(2), 'hex'),
  );
  const isRegistered = await aleoAdapter.isUserRegistered(
    originDomain,
    addressArray,
  );

  if (isRegistered) {
    console.log('User already registered');
    return;
  }

  // Prepare registration transaction
  const registrationTx = await aleoAdapter.populateRegisterUserTx(
    {
      originChain: originDomain,
      originAddress: addressArray,
    },
    aleoWallet,
  );

  console.log('Registration transaction prepared:', registrationTx);
  // Submit to Aleo network via wallet
}

/**
 * Step 2: Deposit tokens on origin chain for private transfer
 */
export async function depositPrivate(
  multiProvider: MultiProtocolProvider,
  originChain: string,
  destinationChain: string,
  tokenAddress: string,
  amount: bigint,
  recipient: string,
  signer: ethers.Signer,
): Promise<{ commitment: string; nonce: number; secret: string }> {
  // Generate secret (must be kept secure!)
  const secret = ethers.utils.hexlify(ethers.utils.randomBytes(32));

  // Create adapter for origin chain
  const adapter = new EvmHypPrivateCollateralAdapter(
    originChain,
    multiProvider,
    {
      token: tokenAddress,
    },
  );

  // Get destination domain
  const destinationDomain = multiProvider.getDomainId(destinationChain);

  // Check router enrolled
  const router = await adapter.getRemoteRouter(destinationDomain);
  if (router === ethers.constants.HashZero) {
    throw new Error(`Destination ${destinationChain} not enrolled`);
  }

  // Check user registration (off-chain check)
  const originDomain = multiProvider.getDomainId(originChain);
  const signerAddress = await signer.getAddress();
  console.log('⚠️  Ensure user is registered on Aleo before depositing');
  console.log(`   Origin: ${originChain} (domain ${originDomain})`);
  console.log(`   Address: ${signerAddress}`);

  // Prepare deposit transaction
  const { tx, commitment, nonce } = await adapter.populateDepositPrivateTx({
    secret,
    finalDestination: destinationDomain,
    recipient,
    amount,
  });

  // Submit transaction
  const txResponse = await signer.sendTransaction(tx);
  console.log('Deposit transaction sent:', txResponse.hash);
  await txResponse.wait();

  // Save commitment info (user needs this to claim on Aleo)
  console.log('Save this information securely:');
  console.log(`  Secret: ${secret}`);
  console.log(`  Commitment: ${commitment}`);
  console.log(`  Nonce: ${nonce}`);

  return { commitment, nonce, secret };
}

/**
 * Step 3: Forward deposit to destination via Aleo
 */
export async function forwardToDestination(
  multiProvider: MultiProtocolProvider,
  secret: string,
  depositRecord: any, // PrivateDeposit record from Aleo
  aleoWallet: AleoWalletAdapter,
): Promise<void> {
  // Create Aleo adapter
  const aleoAdapter = new AleoPrivacyHubAdapter('aleo', multiProvider, {
    privacyHub: 'privacy_hub.aleo',
  });

  // Get hub config
  const hubConfig = await aleoAdapter.getHubConfig();

  // Get remote router for destination
  const remoteRouter = await aleoAdapter.getRemoteRouter(
    depositRecord.finalDestination,
  );
  if (!remoteRouter) {
    throw new Error('Destination router not enrolled on Aleo hub');
  }

  // Get mailbox state (from Aleo mailbox)
  const mailboxState = {
    localDomain: 0, // Aleo domain
    nonce: 0,
    processCount: 0,
    defaultIsm: 'aleo1...',
    defaultHook: 'aleo1...',
    requiredHook: 'aleo1...',
    dispatchProxy: 'dispatch_proxy.aleo',
    mailboxOwner: 'aleo1...',
  };

  // Prepare allowances (if needed for gas payment)
  const allowances = [
    { spender: 'privacy_hub.aleo', amount: 1000000n },
    {
      spender:
        'aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc',
      amount: 0n,
    },
    {
      spender:
        'aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc',
      amount: 0n,
    },
    {
      spender:
        'aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc',
      amount: 0n,
    },
  ];

  // Convert secret to Uint8Array
  const secretBytes = new Uint8Array(Buffer.from(secret.slice(2), 'hex'));

  // Prepare forward transaction
  const forwardTx = await aleoAdapter.populateForwardToDestinationTx(
    {
      deposit: depositRecord,
      secret: secretBytes,
      unverifiedConfig: hubConfig,
      unverifiedMailboxState: mailboxState,
      unverifiedRemoteRouter: remoteRouter,
      allowance: allowances,
    },
    aleoWallet,
  );

  console.log('Forward transaction prepared:', forwardTx);
  // Submit to Aleo network
}

/**
 * Step 4 (Optional): Refund expired deposit
 */
export async function refundExpired(
  multiProvider: MultiProtocolProvider,
  depositRecord: any,
  refundRecipient: string,
  aleoWallet: AleoWalletAdapter,
): Promise<void> {
  // Create Aleo adapter
  const aleoAdapter = new AleoPrivacyHubAdapter('aleo', multiProvider, {
    privacyHub: 'privacy_hub.aleo',
  });

  // Check if deposit is expired
  const currentBlock = 0; // Get from Aleo network
  if (currentBlock <= depositRecord.expiry) {
    throw new Error('Deposit not yet expired');
  }

  // Get mailbox state
  const mailboxState = {
    localDomain: 0,
    nonce: 0,
    processCount: 0,
    defaultIsm: 'aleo1...',
    defaultHook: 'aleo1...',
    requiredHook: 'aleo1...',
    dispatchProxy: 'dispatch_proxy.aleo',
    mailboxOwner: 'aleo1...',
  };

  const allowances = [
    { spender: 'privacy_hub.aleo', amount: 1000000n },
    {
      spender:
        'aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc',
      amount: 0n,
    },
    {
      spender:
        'aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc',
      amount: 0n,
    },
    {
      spender:
        'aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc',
      amount: 0n,
    },
  ];

  // Convert recipient to bytes
  const recipientBytes32 = addressToBytes32(refundRecipient);
  const recipientArray = new Uint8Array(
    Buffer.from(recipientBytes32.slice(2), 'hex'),
  );

  // Prepare refund transaction
  const refundTx = await aleoAdapter.populateRefundExpiredTx(
    {
      deposit: depositRecord,
      refundRecipient: recipientArray,
      unverifiedMailboxState: mailboxState,
      allowance: allowances,
    },
    aleoWallet,
  );

  console.log('Refund transaction prepared:', refundTx);
  // Submit to Aleo network
}

/**
 * Complete example flow
 */
export async function completePrivateTransferFlow() {
  // This is a conceptual example showing the complete flow

  console.log('Privacy Warp Route Flow:');
  console.log('1. User registers on Aleo with their EVM address');
  console.log('2. User deposits tokens on origin chain (EVM)');
  console.log('   - Generates secret commitment');
  console.log('   - Sends message to Aleo privacy hub');
  console.log('3. Aleo creates private deposit record (encrypted on-chain)');
  console.log('4. User forwards deposit to destination using Aleo wallet');
  console.log('   - Proves knowledge of secret');
  console.log('   - Aleo hub sends message to destination');
  console.log('5. Destination chain receives tokens');
  console.log('');
  console.log('Privacy guarantees:');
  console.log('- Origin chain: sees commitment hash, amount, destination');
  console.log('- Aleo network: all details encrypted in private record');
  console.log('- Destination chain: sees commitment hash, amount, recipient');
  console.log('- Observer: cannot link origin sender to destination recipient');
}

/**
 * Commitment file format for saving user secrets
 */
export interface CommitmentFile {
  version: '1.0';
  commitment: string;
  nonce: number;
  secret: string; // KEEP SECURE
  originChain: string;
  destinationChain: string;
  recipient: string;
  amount: string;
  timestamp: number;
  txHash: string;
}

export function createCommitmentFile(
  commitment: string,
  nonce: number,
  secret: string,
  originChain: string,
  destinationChain: string,
  recipient: string,
  amount: bigint,
  txHash: string,
): CommitmentFile {
  return {
    version: '1.0',
    commitment,
    nonce,
    secret,
    originChain,
    destinationChain,
    recipient,
    amount: amount.toString(),
    timestamp: Date.now(),
    txHash,
  };
}
