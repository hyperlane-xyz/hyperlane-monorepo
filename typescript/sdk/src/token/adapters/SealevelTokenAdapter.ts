import {
  TOKEN_2022_PROGRAM_ID,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  AccountMeta,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { deserializeUnchecked, serialize } from 'borsh';

import {
  Address,
  Domain,
  addressToBytes,
  assert,
  eqAddress,
  isNullish,
  median,
  padBytesToLength,
} from '@hyperlane-xyz/utils';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp.js';
import { SEALEVEL_SPL_NOOP_ADDRESS } from '../../consts/sealevel.js';
import {
  IgpPaymentKeys,
  SealevelIgpAdapter,
  SealevelIgpProgramAdapter,
  SealevelOverheadIgpAdapter,
} from '../../gas/adapters/SealevelIgpAdapter.js';
import { SealevelInterchainGasPaymasterType } from '../../gas/adapters/serialization.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import {
  SealevelAccountDataWrapper,
  SealevelInstructionWrapper,
} from '../../utils/sealevelSerialization.js';
import { TokenMetadata } from '../types.js';

import {
  IHypTokenAdapter,
  ITokenAdapter,
  InterchainGasQuote,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';
import {
  SealevelHypTokenInstruction,
  SealevelHyperlaneTokenData,
  SealevelHyperlaneTokenDataSchema,
  SealevelTransferRemoteInstruction,
  SealevelTransferRemoteSchema,
} from './serialization.js';

const NON_EXISTENT_ACCOUNT_ERROR = 'could not find account';

/**
 * The compute limit to set for the transfer remote instruction.
 * This is typically around ~160k, but can be higher depending on
 * the index in the merkle tree, which can result in more moderately
 * more expensive merkle tree insertion.
 * Because a higher compute limit doesn't increase the fee for a transaction,
 * we generously request 1M units.
 */
const TRANSFER_REMOTE_COMPUTE_LIMIT = 1_000_000;

/**
 * The factor by which to multiply the median prioritization fee
 * instruction added to transfer transactions.
 */
const PRIORITY_FEE_PADDING_FACTOR = 2;

/**
 * The minimum priority fee to use if the median fee is
 * unavailable or too low, set in micro-lamports.
 * 100,000 * 1e-6 * 1,000,000 (compute unit limit) / 1e9 == 0.0001 SOL
 */
const MINIMUM_PRIORITY_FEE = 100_000;

// Interacts with native currencies
export class SealevelNativeTokenAdapter
  extends BaseSealevelAdapter
  implements ITokenAdapter<Transaction>
{
  async getBalance(address: Address): Promise<bigint> {
    const balance = await this.getProvider().getBalance(new PublicKey(address));
    return BigInt(balance.toString());
  }

  async getMetadata(): Promise<TokenMetadata> {
    throw new Error('Metadata not available to native tokens');
  }

  // Require a minimum transfer amount to cover rent for the recipient.
  async getMinimumTransferAmount(recipient: Address): Promise<bigint> {
    const recipientPubkey = new PublicKey(recipient);
    const provider = this.getProvider();
    const recipientAccount = await provider.getAccountInfo(recipientPubkey);
    const recipientDataLength = recipientAccount?.data.length ?? 0;
    const recipientLamports = recipientAccount?.lamports ?? 0;

    const minRequiredLamports =
      await provider.getMinimumBalanceForRentExemption(recipientDataLength);

    if (recipientLamports < minRequiredLamports) {
      return BigInt(minRequiredLamports - recipientLamports);
    }

    return 0n;
  }

  async isApproveRequired(): Promise<boolean> {
    return false;
  }

  async isRevokeApprovalRequired(
    _owner: Address,
    _spender: Address,
  ): Promise<boolean> {
    return false;
  }

  async populateApproveTx(): Promise<Transaction> {
    throw new Error('Approve not required for native tokens');
  }

  async populateTransferTx({
    weiAmountOrId,
    recipient,
    fromAccountOwner,
  }: TransferParams): Promise<Transaction> {
    if (!fromAccountOwner)
      throw new Error('fromAccountOwner required for Sealevel');
    return new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(fromAccountOwner),
        toPubkey: new PublicKey(recipient),
        lamports: BigInt(weiAmountOrId),
      }),
    );
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    // Not implemented.
    return undefined;
  }
}

// Interacts with SPL token programs
export class SealevelTokenAdapter
  extends BaseSealevelAdapter
  implements ITokenAdapter<Transaction>
{
  public readonly tokenMintPubKey: PublicKey;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);
    this.tokenMintPubKey = new PublicKey(addresses.token);
  }

  async getBalance(owner: Address): Promise<bigint> {
    const tokenPubKey = await this.deriveAssociatedTokenAccount(
      new PublicKey(owner),
    );
    try {
      const response =
        await this.getProvider().getTokenAccountBalance(tokenPubKey);
      return BigInt(response.value.amount);
    } catch (error: any) {
      if (error.message?.includes(NON_EXISTENT_ACCOUNT_ERROR)) return 0n;
      throw error;
    }
  }

  async getMetadata(_isNft?: boolean): Promise<TokenMetadata> {
    // TODO solana support
    return { decimals: 9, symbol: 'SPL', name: 'SPL Token' };
  }

  async getMinimumTransferAmount(_recipient: Address): Promise<bigint> {
    return 0n;
  }

  async isApproveRequired(): Promise<boolean> {
    return false;
  }

  async isRevokeApprovalRequired(
    _owner: Address,
    _spender: Address,
  ): Promise<boolean> {
    return false;
  }

  populateApproveTx(_params: TransferParams): Promise<Transaction> {
    throw new Error('Approve not required for sealevel tokens');
  }

  async populateTransferTx({
    weiAmountOrId,
    recipient,
    fromAccountOwner,
    fromTokenAccount,
  }: TransferParams): Promise<Transaction> {
    if (!fromTokenAccount)
      throw new Error('fromTokenAccount required for Sealevel');
    if (!fromAccountOwner)
      throw new Error('fromAccountOwner required for Sealevel');
    return new Transaction().add(
      createTransferInstruction(
        new PublicKey(fromTokenAccount),
        new PublicKey(recipient),
        new PublicKey(fromAccountOwner),
        BigInt(weiAmountOrId),
      ),
    );
  }

  async getTokenProgramId(): Promise<PublicKey> {
    const svmProvider = this.getProvider();

    const mintInfo = await svmProvider.getAccountInfo(
      new PublicKey(this.addresses.token),
    );

    if (!mintInfo) {
      throw new Error(
        `Provided SVM account ${this.addresses.token} does not exist`,
      );
    }

    return mintInfo.owner;
  }

  async isSpl2022(): Promise<boolean> {
    const tokenProgramId = await this.getTokenProgramId();

    return tokenProgramId.equals(TOKEN_2022_PROGRAM_ID);
  }

  async deriveAssociatedTokenAccount(owner: PublicKey): Promise<PublicKey> {
    const tokenProgramId = await this.getTokenProgramId();
    return getAssociatedTokenAddressSync(
      this.tokenMintPubKey,
      owner,
      true,
      tokenProgramId,
    );
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    const response = await this.getProvider().getTokenSupply(
      this.tokenMintPubKey,
    );
    return BigInt(response.value.amount);
  }
}

interface HypTokenAddresses {
  token: Address;
  warpRouter: Address;
  mailbox: Address;
}

export abstract class SealevelHypTokenAdapter
  extends SealevelTokenAdapter
  implements IHypTokenAdapter<Transaction>
{
  public readonly warpProgramPubKey: PublicKey;
  public readonly addresses: HypTokenAddresses;
  protected cachedTokenAccountData: SealevelHyperlaneTokenData | undefined;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    addresses: HypTokenAddresses,
  ) {
    super(chainName, multiProvider, { token: addresses.token });
    this.addresses = addresses;
    this.warpProgramPubKey = new PublicKey(addresses.warpRouter);
  }

  async getTokenAccountData(): Promise<SealevelHyperlaneTokenData> {
    if (!this.cachedTokenAccountData) {
      const tokenPda = this.deriveHypTokenAccount();
      const accountInfo = await this.getProvider().getAccountInfo(tokenPda);
      if (!accountInfo)
        throw new Error(`No account info found for ${tokenPda}`);
      const wrappedData = deserializeUnchecked(
        SealevelHyperlaneTokenDataSchema,
        SealevelAccountDataWrapper,
        accountInfo.data,
      );
      this.cachedTokenAccountData =
        wrappedData.data as SealevelHyperlaneTokenData;
    }
    return this.cachedTokenAccountData;
  }

  override async getMetadata(): Promise<TokenMetadata> {
    const tokenData = await this.getTokenAccountData();
    // TODO full token metadata support
    return {
      decimals: tokenData.decimals,
      symbol: 'HYP',
      name: 'Unknown Hyp Token',
    };
  }

  async getDomains(): Promise<Domain[]> {
    const routers = await this.getAllRouters();
    return routers.map((router) => router.domain);
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    const routers = await this.getAllRouters();
    const addr = routers.find((router) => router.domain === domain)?.address;
    if (!addr) throw new Error(`No router found for ${domain}`);
    return addr;
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    const tokenData = await this.getTokenAccountData();
    const domainToPubKey = tokenData.remote_router_pubkeys;
    return Array.from(domainToPubKey.entries()).map(([domain, pubKey]) => ({
      domain,
      address: pubKey.toBuffer(),
    }));
  }

  // Intended to be overridden by subclasses
  async getBridgedSupply(): Promise<bigint | undefined> {
    return undefined;
  }

  // The sender is required, as simulating a transaction on Sealevel requires
  // a payer to be specified that has sufficient funds to cover the transaction fee.
  async quoteTransferRemoteGas(
    destination: Domain,
    sender?: Address,
  ): Promise<InterchainGasQuote> {
    const tokenData = await this.getTokenAccountData();
    const destinationGas = tokenData.destination_gas?.get(destination);
    if (isNullish(destinationGas)) {
      return { amount: 0n };
    }

    const igp = this.getIgpAdapter(tokenData);
    if (!igp) {
      return { amount: 0n };
    }

    assert(sender, 'Sender required for Sealevel transfer remote gas quote');

    return {
      amount: await igp.quoteGasPayment(
        destination,
        destinationGas,
        new PublicKey(sender),
      ),
    };
  }

  async populateTransferRemoteTx({
    weiAmountOrId,
    destination,
    recipient,
    fromAccountOwner,
  }: TransferRemoteParams): Promise<Transaction> {
    if (!fromAccountOwner)
      throw new Error('fromAccountOwner required for Sealevel');
    const randomWallet = Keypair.generate();
    const fromWalletPubKey = new PublicKey(fromAccountOwner);
    const mailboxPubKey = new PublicKey(this.addresses.mailbox);

    const keys = await this.getTransferInstructionKeyList({
      sender: fromWalletPubKey,
      mailbox: mailboxPubKey,
      randomWallet: randomWallet.publicKey,
      igp: await this.getIgpKeys(),
    });

    const value = new SealevelInstructionWrapper({
      instruction: SealevelHypTokenInstruction.TransferRemote,
      data: new SealevelTransferRemoteInstruction({
        destination_domain: destination,
        recipient: padBytesToLength(addressToBytes(recipient), 32),
        amount_or_id: BigInt(weiAmountOrId),
      }),
    });
    const serializedData = serialize(SealevelTransferRemoteSchema, value);

    const transferRemoteInstruction = new TransactionInstruction({
      keys,
      programId: this.warpProgramPubKey,
      // Array of 1s is an arbitrary 8 byte "discriminator"
      // https://github.com/hyperlane-xyz/issues/issues/462#issuecomment-1587859359
      data: Buffer.concat([
        Buffer.from([1, 1, 1, 1, 1, 1, 1, 1]),
        Buffer.from(serializedData),
      ]),
    });

    const setComputeLimitInstruction = ComputeBudgetProgram.setComputeUnitLimit(
      { units: TRANSFER_REMOTE_COMPUTE_LIMIT },
    );

    // For more info about priority fees, see:
    // https://solanacookbook.com/references/basic-transactions.html#how-to-change-compute-budget-fee-priority-for-a-transaction
    // https://docs.phantom.app/developer-powertools/solana-priority-fees
    // https://www.helius.dev/blog/priority-fees-understanding-solanas-transaction-fee-mechanics
    const setPriorityFeeInstruction = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: (await this.getMedianPriorityFee()) || 0,
    });

    const recentBlockhash = (
      await this.getProvider().getLatestBlockhash('finalized')
    ).blockhash;

    // @ts-ignore Workaround for bug in the web3 lib, sometimes uses recentBlockhash and sometimes uses blockhash
    const tx = new Transaction({
      feePayer: fromWalletPubKey,
      blockhash: recentBlockhash,
      recentBlockhash,
    })
      .add(setComputeLimitInstruction)
      .add(setPriorityFeeInstruction)
      .add(transferRemoteInstruction);
    tx.partialSign(randomWallet);
    return tx;
  }

  async getIgpKeys(): Promise<IgpPaymentKeys | undefined> {
    const tokenData = await this.getTokenAccountData();
    const igpAdapter = this.getIgpAdapter(tokenData);
    return igpAdapter?.getPaymentKeys();
  }

  // Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/libraries/hyperlane-sealevel-token/src/processor.rs#L257-L274
  async getTransferInstructionKeyList({
    sender,
    mailbox,
    randomWallet,
    igp,
  }: KeyListParams): Promise<Array<AccountMeta>> {
    let keys = [
      // 0.   [executable] The system program.
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // 1.   [executable] The spl_noop program.
      {
        pubkey: new PublicKey(SEALEVEL_SPL_NOOP_ADDRESS),
        isSigner: false,
        isWritable: false,
      },
      // 2.   [] The token PDA account.
      {
        pubkey: this.deriveHypTokenAccount(),
        isSigner: false,
        isWritable: false,
      },
      // 3.   [executable] The mailbox program.
      { pubkey: mailbox, isSigner: false, isWritable: false },
      // 4.   [writeable] The mailbox outbox account.
      {
        pubkey: this.deriveMailboxOutboxAccount(mailbox),
        isSigner: false,
        isWritable: true,
      },
      // 5.   [] Message dispatch authority.
      {
        pubkey: this.deriveMessageDispatchAuthorityAccount(),
        isSigner: false,
        isWritable: false,
      },
      // 6.   [signer] The token sender and mailbox payer.
      { pubkey: sender, isSigner: true, isWritable: false },
      // 7.   [signer] Unique message account.
      { pubkey: randomWallet, isSigner: true, isWritable: false },
      // 8.   [writeable] Message storage PDA.
      {
        pubkey: this.deriveMsgStorageAccount(mailbox, randomWallet),
        isSigner: false,
        isWritable: true,
      },
    ];
    if (igp) {
      keys = [
        ...keys,
        // 9.    [executable] The IGP program.
        { pubkey: igp.programId, isSigner: false, isWritable: false },
        // 10.   [writeable] The IGP program data.
        {
          pubkey: SealevelOverheadIgpAdapter.deriveIgpProgramPda(igp.programId),
          isSigner: false,
          isWritable: true,
        },
        // 11.   [writeable] Gas payment PDA.
        {
          pubkey: SealevelOverheadIgpAdapter.deriveGasPaymentPda(
            igp.programId,
            randomWallet,
          ),
          isSigner: false,
          isWritable: true,
        },
      ];
      if (igp.overheadIgpAccount) {
        keys = [
          ...keys,
          // 12.   [] OPTIONAL - The Overhead IGP account, if the configured IGP is an Overhead IGP
          {
            pubkey: igp.overheadIgpAccount,
            isSigner: false,
            isWritable: false,
          },
        ];
      }
      keys = [
        ...keys,
        // 13.   [writeable] The Overhead's inner IGP account (or the normal IGP account if there's no Overhead IGP).
        {
          pubkey: igp.igpAccount,
          isSigner: false,
          isWritable: true,
        },
      ];
    }
    return keys;
  }

  // https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/mailbox/src/pda_seeds.rs#L19
  deriveMailboxOutboxAccount(mailbox: PublicKey): PublicKey {
    return super.derivePda(['hyperlane', '-', 'outbox'], mailbox);
  }

  // https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/mailbox/src/pda_seeds.rs#L57
  deriveMessageDispatchAuthorityAccount(): PublicKey {
    return super.derivePda(
      ['hyperlane_dispatcher', '-', 'dispatch_authority'],
      this.warpProgramPubKey,
    );
  }

  // https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/mailbox/src/pda_seeds.rs#L33-L37
  deriveMsgStorageAccount(
    mailbox: PublicKey,
    randomWalletPubKey: PublicKey,
  ): PublicKey {
    return super.derivePda(
      [
        'hyperlane',
        '-',
        'dispatched_message',
        '-',
        randomWalletPubKey.toBuffer(),
      ],
      mailbox,
    );
  }

  // Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/libraries/hyperlane-sealevel-token/src/processor.rs#LL49C1-L53C30
  deriveHypTokenAccount(): PublicKey {
    return super.derivePda(
      ['hyperlane_message_recipient', '-', 'handle', '-', 'account_metas'],
      this.warpProgramPubKey,
    );
  }

  // Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/4b3537470eff0139163a2a7aa1d19fc708a992c6/rust/sealevel/programs/hyperlane-sealevel-token/src/plugin.rs#L43-L51
  deriveAtaPayerAccount(): PublicKey {
    return super.derivePda(
      ['hyperlane_token', '-', 'ata_payer'],
      this.warpProgramPubKey,
    );
  }

  /**
   * Fetches the median prioritization fee for transfers of the collateralAddress token.
   * @returns The median prioritization fee in micro-lamports, defaults to `0` when chain is not solanamainnet
   */
  async getMedianPriorityFee(): Promise<number | undefined> {
    this.logger.debug('Fetching priority fee history for token transfer');

    // Currently only transactions done in solana requires a priority
    if (this.chainName !== 'solanamainnet') {
      this.logger.debug(
        `Chain ${this.chainName} does not need priority fee, defaulting to 0`,
      );
      return 0;
    }

    const collateralAddress = this.addresses.token;
    const fees = await this.getProvider().getRecentPrioritizationFees({
      lockedWritableAccounts: [new PublicKey(collateralAddress)],
    });

    const nonZeroFees = fees
      .filter((fee) => fee.prioritizationFee > 0)
      .map((fee) => fee.prioritizationFee);

    if (nonZeroFees.length < 3) {
      this.logger.warn(
        'Insufficient historical prioritization fee data for padding, skipping',
      );
      return MINIMUM_PRIORITY_FEE;
    }

    const medianFee = Math.max(
      Math.floor(median(nonZeroFees) * PRIORITY_FEE_PADDING_FACTOR),
      MINIMUM_PRIORITY_FEE,
    );

    this.logger.debug(`Median priority fee: ${medianFee}`);
    return medianFee;
  }

  protected getIgpAdapter(
    tokenData: SealevelHyperlaneTokenData,
  ): SealevelIgpProgramAdapter | undefined {
    const igpConfig = tokenData.interchain_gas_paymaster;

    if (!igpConfig || igpConfig.igp_account_pub_key === undefined) {
      return undefined;
    }

    if (igpConfig.type === SealevelInterchainGasPaymasterType.Igp) {
      return new SealevelIgpAdapter(this.chainName, this.multiProvider, {
        igp: igpConfig.igp_account_pub_key.toBase58(),
        programId: igpConfig.program_id_pubkey.toBase58(),
      });
    } else if (
      igpConfig.type === SealevelInterchainGasPaymasterType.OverheadIgp
    ) {
      return new SealevelOverheadIgpAdapter(
        this.chainName,
        this.multiProvider,
        {
          overheadIgp: igpConfig.igp_account_pub_key.toBase58(),
          programId: igpConfig.program_id_pubkey.toBase58(),
        },
      );
    } else {
      throw new Error(`Unsupported IGP type ${igpConfig.type}`);
    }
  }
}

// Interacts with Hyp Native token programs
export class SealevelHypNativeAdapter extends SealevelHypTokenAdapter {
  public readonly wrappedNative: SealevelNativeTokenAdapter;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    addresses: {
      // A 'token' address is not required for hyp native tokens (e.g. hypSOL)
      token?: Address;
      warpRouter: Address;
      mailbox: Address;
    },
  ) {
    // Pass in placeholder address for 'token' to avoid errors in the parent classes
    super(chainName, multiProvider, {
      ...addresses,
      token: SystemProgram.programId.toBase58(),
    });
    this.wrappedNative = new SealevelNativeTokenAdapter(
      chainName,
      multiProvider,
      {},
    );
  }

  override async getBalance(owner: Address): Promise<bigint> {
    if (eqAddress(owner, this.addresses.warpRouter)) {
      const collateralAccount = this.deriveNativeTokenCollateralAccount();
      const balance = await this.getProvider().getBalance(collateralAccount);
      // TODO: account for rent in https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/4558
      return BigInt(balance.toString());
    }
    return this.wrappedNative.getBalance(owner);
  }

  override async getBridgedSupply(): Promise<bigint> {
    return this.getBalance(this.addresses.warpRouter);
  }

  override async getMetadata(): Promise<TokenMetadata> {
    return this.wrappedNative.getMetadata();
  }

  override async getMinimumTransferAmount(recipient: Address): Promise<bigint> {
    return this.wrappedNative.getMinimumTransferAmount(recipient);
  }

  override async getMedianPriorityFee(): Promise<number | undefined> {
    // Native tokens don't have a collateral address, so we don't fetch
    // prioritization fee history
    return undefined;
  }

  async getTransferInstructionKeyList(
    params: KeyListParams,
  ): Promise<Array<AccountMeta>> {
    return [
      ...(await super.getTransferInstructionKeyList(params)),
      // 9.   [executable] The system program.
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // 10.  [writeable] The native token collateral PDA account.
      {
        pubkey: this.deriveNativeTokenCollateralAccount(),
        isSigner: false,
        isWritable: true,
      },
    ];
  }

  // https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/hyperlane-sealevel-token-native/src/plugin.rs#L26
  deriveNativeTokenCollateralAccount(): PublicKey {
    return super.derivePda(
      ['hyperlane_token', '-', 'native_collateral'],
      this.warpProgramPubKey,
    );
  }

  deriveAtaPayerAccount(): PublicKey {
    throw new Error('No ATA payer is used for native warp routes');
  }
}

// Interacts with Hyp Collateral token programs
export class SealevelHypCollateralAdapter extends SealevelHypTokenAdapter {
  async getBalance(owner: Address): Promise<bigint> {
    // Special case where the owner is the warp route program ID.
    // This is because collateral warp routes don't hold escrowed collateral
    // tokens in their associated token account - instead, they hold them in
    // the escrow account.
    if (eqAddress(owner, this.addresses.warpRouter)) {
      const collateralAccount = this.deriveEscrowAccount();
      const response =
        await this.getProvider().getTokenAccountBalance(collateralAccount);
      return BigInt(response.value.amount);
    }

    return super.getBalance(owner);
  }

  override async getBridgedSupply(): Promise<bigint> {
    return this.getBalance(this.addresses.warpRouter);
  }

  override async getTransferInstructionKeyList(
    params: KeyListParams,
  ): Promise<Array<AccountMeta>> {
    return [
      ...(await super.getTransferInstructionKeyList(params)),
      /// 9.   [executable] The SPL token program for the mint.
      {
        pubkey: await this.getTokenProgramId(),
        isSigner: false,
        isWritable: false,
      },
      /// 10.  [writeable] The mint.
      { pubkey: this.tokenMintPubKey, isSigner: false, isWritable: true },
      /// 11.  [writeable] The token sender's associated token account, from which tokens will be sent.
      {
        pubkey: await this.deriveAssociatedTokenAccount(params.sender),
        isSigner: false,
        isWritable: true,
      },
      /// 12.  [writeable] The escrow PDA account.
      { pubkey: this.deriveEscrowAccount(), isSigner: false, isWritable: true },
    ];
  }

  deriveEscrowAccount(): PublicKey {
    return super.derivePda(
      ['hyperlane_token', '-', 'escrow'],
      this.warpProgramPubKey,
    );
  }
}

// Interacts with Hyp Synthetic token programs (aka 'HypTokens')
export class SealevelHypSyntheticAdapter extends SealevelHypTokenAdapter {
  override async getTransferInstructionKeyList(
    params: KeyListParams,
  ): Promise<Array<AccountMeta>> {
    return [
      ...(await super.getTransferInstructionKeyList(params)),
      /// 9. [executable] The spl_token_2022 program.
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      /// 10. [writeable] The mint / mint authority PDA account.
      {
        pubkey: this.deriveMintAuthorityAccount(),
        isSigner: false,
        isWritable: true,
      },
      /// 11. [writeable] The token sender's associated token account, from which tokens will be burned.
      {
        pubkey: await this.deriveAssociatedTokenAccount(params.sender),
        isSigner: false,
        isWritable: true,
      },
    ];
  }

  override async getBalance(owner: Address): Promise<bigint> {
    const tokenPubKey = await this.deriveAssociatedTokenAccount(
      new PublicKey(owner),
    );
    try {
      const response =
        await this.getProvider().getTokenAccountBalance(tokenPubKey);
      return BigInt(response.value.amount);
    } catch (error: any) {
      if (error.message?.includes(NON_EXISTENT_ACCOUNT_ERROR)) return 0n;
      throw error;
    }
  }

  override async getBridgedSupply(): Promise<bigint> {
    return this.getTotalSupply();
  }

  async getTotalSupply(): Promise<bigint> {
    const response = await this.getProvider().getTokenSupply(
      this.tokenMintPubKey,
    );
    return BigInt(response.value.amount);
  }

  deriveMintAuthorityAccount(): PublicKey {
    return super.derivePda(
      ['hyperlane_token', '-', 'mint'],
      this.warpProgramPubKey,
    );
  }

  override async deriveAssociatedTokenAccount(
    owner: PublicKey,
  ): Promise<PublicKey> {
    return getAssociatedTokenAddressSync(
      this.deriveMintAuthorityAccount(),
      new PublicKey(owner),
      true,
      TOKEN_2022_PROGRAM_ID,
    );
  }
}

interface KeyListParams {
  sender: PublicKey;
  mailbox: PublicKey;
  randomWallet: PublicKey;
  igp?: IgpPaymentKeys;
}
