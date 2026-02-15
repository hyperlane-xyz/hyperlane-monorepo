import { AleoTransaction } from '@hyperlane-xyz/aleo-sdk';
import { Address, Domain, assert } from '@hyperlane-xyz/utils';

import { BaseAleoAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { AleoProvider } from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';

export interface AleoWalletInterface {
  getAddress(): Promise<string>;
  signTransaction(tx: any): Promise<string>;
}

export interface DepositRecord {
  owner: string;
  commitment: string;
  nonce: number;
  amount: [bigint, bigint]; // u256 as [u128, u128]
  finalDestination: number;
  recipient: Uint8Array; // 32 bytes
  destinationRouter: Uint8Array; // 32 bytes
  originChain: number;
  tokenId: string;
  timestamp: number;
  expiry: number;
}

export interface ForwardParams {
  deposit: DepositRecord;
  secret: Uint8Array; // 32 bytes
  unverifiedConfig: HubConfig;
  unverifiedMailboxState: MailboxState;
  unverifiedRemoteRouter: RemoteRouter;
  allowance: CreditAllowance[];
}

export interface RefundParams {
  deposit: DepositRecord;
  refundRecipient: Uint8Array; // 32 bytes
  unverifiedMailboxState: MailboxState;
  allowance: CreditAllowance[];
}

export interface HubConfig {
  admin: string;
  minClaimDelay: number;
  expiryBlocks: number;
  paused: boolean;
}

export interface RemoteRouter {
  domain: number;
  recipient: Uint8Array; // 32 bytes
  gas: bigint;
}

export interface MailboxState {
  localDomain: number;
  nonce: number;
  processCount: number;
  defaultIsm: string;
  defaultHook: string;
  requiredHook: string;
  dispatchProxy: string;
  mailboxOwner: string;
}

export interface CreditAllowance {
  spender: string;
  amount: bigint;
}

export interface RegistrationParams {
  originChain: number;
  originAddress: Uint8Array; // 32 bytes
}

/**
 * Adapter for interacting with Aleo privacy hub
 * Handles user registration, deposit forwarding, and refunds
 */
export class AleoPrivacyHubAdapter extends BaseAleoAdapter {
  protected provider: AleoProvider['provider'];
  protected programId: string;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { privacyHub: Address },
  ) {
    super(chainName, multiProvider, addresses);
    this.provider = this.getProvider();
    this.programId = addresses.privacyHub;
  }

  /**
   * Register user's EVM address with their Aleo address
   * Must be called before deposits can be claimed on Aleo
   */
  async populateRegisterUserTx(
    params: RegistrationParams,
    aleoWallet: AleoWalletInterface,
  ): Promise<AleoTransaction> {
    await aleoWallet.getAddress(); // Verify wallet is accessible

    // Prepare transition call
    const transition = {
      program: this.programId,
      function: 'register_user',
      inputs: [
        params.originChain.toString() + 'u32', // origin_chain: u32
        this.bytes32ToAleoArray(params.originAddress), // origin_address: [u8; 32]
      ],
    };

    return {
      program: this.programId,
      programName: this.programId,
      functionName: 'register_user',
      inputs: transition.inputs,
      priorityFee: 0,
      privateFee: false,
    };
  }

  /**
   * Check if user is registered
   */
  async isUserRegistered(
    originChain: number,
    originAddress: Uint8Array,
  ): Promise<boolean> {
    try {
      const registrationKey = this.computeRegistrationKey(
        originChain,
        originAddress,
      );
      // Mock implementation - requires Aleo SDK with mapping support
      this.logger.debug('Checking registration', {
        programId: this.programId,
        registrationKey,
      });
      // TODO: Implement with Aleo SDK once available
      return false;
    } catch (error) {
      this.logger.debug('Registration check failed', { error });
      return false;
    }
  }

  /**
   * Get user's registered Aleo address
   */
  async getRegisteredAleoAddress(
    originChain: number,
    originAddress: Uint8Array,
  ): Promise<string | null> {
    try {
      const registrationKey = this.computeRegistrationKey(
        originChain,
        originAddress,
      );
      // Mock implementation - requires Aleo SDK with mapping support
      this.logger.debug('Fetching Aleo address', {
        programId: this.programId,
        registrationKey,
      });
      // TODO: Implement with Aleo SDK once available
      return null;
    } catch (error) {
      this.logger.debug('Failed to fetch registered Aleo address', { error });
      return null;
    }
  }

  /**
   * Forward deposit to destination chain
   * Only the deposit owner can call this
   */
  async populateForwardToDestinationTx(
    params: ForwardParams,
    aleoWallet: AleoWalletInterface,
  ): Promise<AleoTransaction> {
    const aleoAddress = await aleoWallet.getAddress();

    // Verify ownership
    assert(
      params.deposit.owner === aleoAddress,
      `Only deposit owner can forward. Expected ${params.deposit.owner}, got ${aleoAddress}`,
    );

    // Prepare inputs
    const inputs = [
      this.encodeDepositRecord(params.deposit), // private deposit: PrivateDeposit
      this.bytes32ToAleoArray(params.secret), // public secret: [u8; 32]
      this.encodeHubConfig(params.unverifiedConfig), // public unverified_config: HubConfig
      this.encodeMailboxState(params.unverifiedMailboxState), // public unverified_mailbox_state: MailboxState
      this.encodeRemoteRouter(params.unverifiedRemoteRouter), // public unverified_remote_router: RemoteRouter
      this.encodeAllowanceArray(params.allowance), // public allowance: [CreditAllowance; 4]
    ];

    return {
      program: this.programId,
      programName: this.programId,
      functionName: 'forward_to_destination',
      inputs,
      priorityFee: 0,
      privateFee: false,
    };
  }

  /**
   * Refund expired deposit back to origin chain
   * Only the deposit owner can call this
   */
  async populateRefundExpiredTx(
    params: RefundParams,
    aleoWallet: AleoWalletInterface,
  ): Promise<AleoTransaction> {
    const aleoAddress = await aleoWallet.getAddress();

    // Verify ownership
    assert(
      params.deposit.owner === aleoAddress,
      `Only deposit owner can refund. Expected ${params.deposit.owner}, got ${aleoAddress}`,
    );

    const inputs = [
      this.encodeDepositRecord(params.deposit), // private deposit: PrivateDeposit
      this.bytes32ToAleoArray(params.refundRecipient), // public refund_recipient: [u8; 32]
      this.encodeMailboxState(params.unverifiedMailboxState), // public unverified_mailbox_state: MailboxState
      this.encodeAllowanceArray(params.allowance), // public allowance: [CreditAllowance; 4]
    ];

    return {
      program: this.programId,
      programName: this.programId,
      functionName: 'refund_expired',
      inputs,
      priorityFee: 0,
      privateFee: false,
    };
  }

  /**
   * Get hub configuration
   */
  async getHubConfig(): Promise<HubConfig> {
    // Mock implementation - requires Aleo SDK with mapping support
    this.logger.debug('Fetching hub config', { programId: this.programId });
    // TODO: Implement with Aleo SDK once available
    throw new Error('getHubConfig requires Aleo SDK with mapping support');
  }

  /**
   * Get remote router configuration
   */
  async getRemoteRouter(domain: Domain): Promise<RemoteRouter | null> {
    try {
      // Mock implementation - requires Aleo SDK with mapping support
      this.logger.debug('Fetching remote router', {
        programId: this.programId,
        domain,
      });
      // TODO: Implement with Aleo SDK once available
      return null;
    } catch (error) {
      this.logger.debug('Failed to fetch remote router', { domain, error });
      return null;
    }
  }

  /**
   * Check if commitment has been used
   */
  async isCommitmentUsed(commitment: string): Promise<boolean> {
    try {
      // Mock implementation - requires Aleo SDK with mapping support
      this.logger.debug('Checking commitment', {
        programId: this.programId,
        commitment,
      });
      // TODO: Implement with Aleo SDK once available
      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get deposit records owned by an address
   * Note: This requires scanning the chain, expensive operation
   */
  async getDepositRecords(owner: string): Promise<DepositRecord[]> {
    // This would require scanning transaction history
    // Implementation depends on Aleo indexer/explorer API
    throw new Error(
      'getDepositRecords requires Aleo indexer API - not yet implemented',
    );
  }

  // Helper methods

  private computeRegistrationKey(chain: number, address: Uint8Array): string {
    // Pack chain ID (4 bytes) + address (32 bytes) and hash
    // Matches Aleo program's compute_registration_key
    const packed = new Uint8Array(36);
    const view = new DataView(packed.buffer);
    view.setUint32(0, chain, true); // little-endian
    packed.set(address, 4);

    return this.keccak256ToField(packed);
  }

  private keccak256ToField(data: Uint8Array): string {
    // Aleo uses Keccak256::hash_to_field
    // This needs to match the Aleo implementation
    // For now, placeholder - requires proper Keccak256 implementation
    throw new Error('keccak256ToField not yet implemented - requires Aleo SDK');
  }

  private bytes32ToAleoArray(bytes: Uint8Array): string {
    assert(bytes.length === 32, `Expected 32 bytes, got ${bytes.length}`);
    // Convert to Aleo array notation: [0u8, 1u8, ..., 31u8]
    return (
      '[' +
      Array.from(bytes)
        .map((b) => `${b}u8`)
        .join(',') +
      ']'
    );
  }

  private encodeDepositRecord(deposit: DepositRecord): string {
    // Encode as Aleo record notation
    // This is a placeholder - actual encoding depends on Aleo SDK
    return JSON.stringify(deposit);
  }

  private encodeHubConfig(config: HubConfig): string {
    return `{admin: ${config.admin}, min_claim_delay: ${config.minClaimDelay}u32, expiry_blocks: ${config.expiryBlocks}u32, paused: ${config.paused}}`;
  }

  private encodeRemoteRouter(router: RemoteRouter): string {
    return `{domain: ${router.domain}u32, recipient: ${this.bytes32ToAleoArray(router.recipient)}, gas: ${router.gas}u128}`;
  }

  private encodeMailboxState(state: MailboxState): string {
    return `{local_domain: ${state.localDomain}u32, nonce: ${state.nonce}u32, process_count: ${state.processCount}u32, default_ism: ${state.defaultIsm}, default_hook: ${state.defaultHook}, required_hook: ${state.requiredHook}, dispatch_proxy: ${state.dispatchProxy}, mailbox_owner: ${state.mailboxOwner}}`;
  }

  private encodeAllowanceArray(allowances: CreditAllowance[]): string {
    // Pad to 4 elements
    while (allowances.length < 4) {
      allowances.push({
        spender:
          'aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc',
        amount: 0n,
      });
    }
    const encoded = allowances
      .slice(0, 4)
      .map((a) => `{spender: ${a.spender}, amount: ${a.amount}u64}`)
      .join(',');
    return `[${encoded}]`;
  }
}
