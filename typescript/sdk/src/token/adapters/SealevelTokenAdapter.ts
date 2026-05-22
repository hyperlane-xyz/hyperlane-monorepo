import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getTokenMetadata,
} from '@solana/spl-token';
import {
  AccountMeta,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { deserializeUnchecked, serialize } from 'borsh';

import {
  Address,
  Domain,
  LazyAsync,
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
import {
  SealevelIgpFeeConfig,
  SealevelInterchainGasPaymasterType,
} from '../../gas/adapters/serialization.js';
import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';
import { ChainName } from '../../types.js';
import {
  SealevelAccountDataWrapper,
  SealevelInstructionWrapper,
} from '../../utils/sealevelSerialization.js';
import { getLegacySPLTokenMetadata } from '../sealevel/metadata.js';
import { TokenMetadata } from '../types.js';

import {
  IHypTokenAdapter,
  ITokenAdapter,
  InterchainGasQuote,
  Quote,
  QuoteTransferRemoteParams,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';
import {
  simulateFeeQuoteAccountMetas,
  simulateIgpQuote,
  simulateIgpQuoteAccountMetas,
  simulateWarpFee,
} from './sealevelFee.js';
import {
  SealevelFeeAccountPrefix,
  SealevelFeeAccountPrefixSchema,
  SealevelHypTokenInstruction,
  SealevelHyperlaneTokenData,
  SealevelHyperlaneTokenDataSchema,
  SealevelTokenFeeConfig,
  SealevelTransferRemoteInstruction,
  SealevelTransferRemoteSchema,
  decodeTrailingFeeConfig,
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
export const TRANSFER_REMOTE_COMPUTE_LIMIT = 1_000_000;

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
    const { nativeToken } = this.multiProvider.getChainMetadata(this.chainName);
    assert(
      nativeToken,
      `Native token data is required for ${SealevelNativeTokenAdapter.name}`,
    );

    return {
      name: nativeToken.name,
      symbol: nativeToken.symbol,
      decimals: nativeToken.decimals,
    };
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
    public readonly multiProvider: MultiProviderAdapter,
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
    const svmProvider = this.getProvider();

    const isSpl2022Token = await this.isSpl2022();

    const tokenAddress = new PublicKey(this.addresses.token);
    const [tokenInfo, metadata] = await Promise.all([
      getMint(
        svmProvider,
        tokenAddress,
        'finalized',
        isSpl2022Token ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
      ),
      isSpl2022Token
        ? getTokenMetadata(
            svmProvider,
            tokenAddress,
            'finalized',
            TOKEN_2022_PROGRAM_ID,
          )
        : getLegacySPLTokenMetadata(svmProvider, tokenAddress),
    ]);

    assert(
      metadata,
      `Metadata for SVM token at address "${this.addresses.token}" on chain "${this.chainName}" not found`,
    );
    return {
      decimals: tokenInfo.decimals,
      symbol: metadata.symbol,
      name: metadata.name,
    };
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
    if (!fromAccountOwner)
      throw new Error('fromAccountOwner required for Sealevel');

    const originTokenAccount = fromTokenAccount
      ? new PublicKey(fromTokenAccount)
      : await this.deriveAssociatedTokenAccount(
          new PublicKey(fromAccountOwner),
        );
    const destinationTokenAccount = await this.deriveAssociatedTokenAccount(
      new PublicKey(recipient),
    );
    const tokenProgramAccount = (await this.isSpl2022())
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;

    const transaction = new Transaction();

    // if the ATA does not exist we need to create it before transferring the tokens
    const toTokenAccountInfo = await this.getProvider().getAccountInfo(
      destinationTokenAccount,
    );
    if (!toTokenAccountInfo) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          new PublicKey(fromAccountOwner),
          destinationTokenAccount,
          new PublicKey(recipient),
          this.tokenMintPubKey,
          tokenProgramAccount,
        ),
      );
    }

    transaction.add(
      createTransferInstruction(
        originTokenAccount,
        destinationTokenAccount,
        new PublicKey(fromAccountOwner),
        BigInt(weiAmountOrId),
        [],
        tokenProgramAccount,
      ),
    );

    return transaction;
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

export interface SealevelAltAddresses {
  core: Address;
  warpSpecific: Address[];
}

/**
 * Building blocks of a `transfer_remote` (or `transfer_remote_to`) tx — the
 * Sealevel adapter exposes this for composable callers (e.g. the offchain-
 * quoted-transfer provider) that need to prepend extra ixs between the
 * compute-budget head and the warp call.
 *
 * Fields are split deliberately:
 *
 *  - `computeBudgetInstructions` — Solana compute-budget ixs. The composing
 *    caller MUST place them at the head of the final tx (priority-fee and
 *    CU-limit ixs are conventionally first; some RPC/wallet stacks rely on
 *    that position when computing per-tx priority).
 *
 *  - `transferInstructions` — the warp `transfer_remote` / `transfer_remote_to`
 *    instructions themselves. Submit-quote ixs (warp fee, IGP) for the
 *    offchain-quoted flow are prepended directly BEFORE these.
 *
 * Final tx order: `[...computeBudgetInstructions, ...submitQuoteIxs?, ...transferInstructions]`.
 */
export interface SealevelTransferBundle {
  computeBudgetInstructions: TransactionInstruction[];
  transferInstructions: TransactionInstruction[];
  addressLookupTableAccounts: AddressLookupTableAccount[];
  feePayer: PublicKey;
  signers: Keypair[];
}

interface HypTokenAddresses {
  token: Address;
  warpRouter: Address;
  mailbox: Address;
  altAddresses?: SealevelAltAddresses;
}

export abstract class SealevelHypTokenAdapter
  extends SealevelTokenAdapter
  implements IHypTokenAdapter<Transaction | VersionedTransaction>
{
  public readonly warpProgramPubKey: PublicKey;
  public readonly addresses: HypTokenAddresses;
  /// Plugin data length in bytes (token-type specific). Required to locate
  /// the optional trailing fee_config in raw account data. Mirrors the
  /// per-plugin struct sizes from
  /// rust/sealevel/programs/hyperlane-sealevel-token-*.
  protected abstract readonly pluginDataSize: number;
  protected readonly tokenAccountData = new LazyAsync(() =>
    this.loadTokenAccountData(),
  );

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProviderAdapter,
    addresses: HypTokenAddresses,
  ) {
    super(chainName, multiProvider, { token: addresses.token });
    this.addresses = addresses;
    this.warpProgramPubKey = new PublicKey(addresses.warpRouter);
  }

  async getTokenAccountData(): Promise<SealevelHyperlaneTokenData> {
    return this.tokenAccountData.get();
  }

  async getFeeConfig(): Promise<SealevelTokenFeeConfig | undefined> {
    const { fee_config } = await this.getTokenAccountData();

    return fee_config;
  }

  /// Cached inner-Igp state. Used to decide new-flow vs legacy IGP quoting
  /// and to build the new-flow QuoteGasPayment account list. For OverheadIgp
  /// routes the inner Igp address is resolved via an extra RPC on the
  /// OverheadIgp PDA.
  protected readonly innerIgpFeeState = new LazyAsync(() =>
    this.loadInnerIgpFeeState(),
  );

  private async loadInnerIgpFeeState(): Promise<
    | {
        innerIgpAccount: PublicKey;
        // Set only when the token's IGP config is OverheadIgp; appended
        // after the cascade on the new-flow QuoteGasPayment / PayForGas
        // account list.
        overheadIgpAccount?: PublicKey;
        feeConfig: SealevelIgpFeeConfig | undefined;
      }
    | undefined
  > {
    const tokenData = await this.getTokenAccountData();
    const igpConfig = tokenData.interchain_gas_paymaster;
    if (!igpConfig || igpConfig.igp_account_pub_key === undefined) {
      return undefined;
    }

    let innerIgpAccount: PublicKey;
    let overheadIgpAccount: PublicKey | undefined;
    if (igpConfig.type === SealevelInterchainGasPaymasterType.Igp) {
      innerIgpAccount = igpConfig.igp_account_pub_key;
    } else if (
      igpConfig.type === SealevelInterchainGasPaymasterType.OverheadIgp
    ) {
      overheadIgpAccount = igpConfig.igp_account_pub_key;
      const overheadIgp = new SealevelOverheadIgpAdapter(
        this.chainName,
        this.multiProvider,
        {
          overheadIgp: overheadIgpAccount.toBase58(),
          programId: igpConfig.program_id_pubkey.toBase58(),
        },
      );
      const overheadData = await overheadIgp.getAccountInfo();
      innerIgpAccount = overheadData.inner_pub_key;
    } else {
      return undefined;
    }

    const innerIgp = new SealevelIgpAdapter(
      this.chainName,
      this.multiProvider,
      {
        igp: innerIgpAccount.toBase58(),
        programId: igpConfig.program_id_pubkey.toBase58(),
      },
    );
    const innerInfo = await innerIgp.getAccountInfo();
    return {
      innerIgpAccount,
      overheadIgpAccount,
      feeConfig: innerInfo.fee_config,
    };
  }

  /**
   * Address-or-denom value used for `tokenFeeQuote.addressOrDenom`. The
   * on-chain fee is deducted from the warp token; native adapters override
   * to return undefined (SOL sentinel).
   */
  protected getFeeTokenAddressOrDenom(): string | undefined {
    return this.tokenMintPubKey.toBase58();
  }

  /// Cached `AddressLookupTableAccount`s fetched from
  /// `this.addresses.altAddresses`. Empty when no ALT addresses are
  /// configured (legacy routes). Used by populateTransferRemote(To)Tx to
  /// compile a `VersionedTransaction` whose account-key footprint fits
  /// under Solana's 1232-byte transaction size limit when the new fee +
  /// IGP-quoted-mode sections push the count past what a legacy
  /// `Transaction` can carry.
  protected readonly addressLookupTableAccounts = new LazyAsync(() =>
    this.loadAddressLookupTableAccounts(),
  );

  private async loadAddressLookupTableAccounts(): Promise<
    AddressLookupTableAccount[]
  > {
    const altAddresses = this.addresses.altAddresses;
    if (!altAddresses) {
      return [];
    }

    const connection = this.getProvider();
    const addresses = [
      new PublicKey(altAddresses.core),
      ...altAddresses.warpSpecific.map((a) => new PublicKey(a)),
    ];

    const results = await Promise.all(
      addresses.map((addr) => connection.getAddressLookupTable(addr)),
    );
    return results.map((r, i) => {
      assert(
        r.value,
        `Sealevel ALT not found on chain: ${addresses[i].toBase58()}`,
      );
      return r.value;
    });
  }

  /// Cached beneficiary owner pubkey from the fee_account. Used to derive
  /// the terminal fee_beneficiary spliced into the warp transfer_remote
  /// fee section. Resolves to undefined when the token has no fee_config.
  protected readonly feeAccountBeneficiaryOwner = new LazyAsync(() =>
    this.loadFeeAccountBeneficiaryOwner(),
  );

  private async loadFeeAccountBeneficiaryOwner(): Promise<
    PublicKey | undefined
  > {
    const tokenData = await this.getTokenAccountData();
    if (!tokenData.fee_config) return undefined;
    const info = await this.getProvider().getAccountInfo(
      tokenData.fee_config.feeAccount,
    );
    assert(
      info,
      `Fee account ${tokenData.fee_config.feeAccount.toBase58()} not found on chain`,
    );
    const wrappedData = deserializeUnchecked(
      SealevelFeeAccountPrefixSchema,
      SealevelAccountDataWrapper,
      info.data,
    );
    const data = wrappedData.data;
    assert(
      data instanceof SealevelFeeAccountPrefix,
      'Decoded wrapper.data is not SealevelFeeAccountPrefix',
    );
    return data.beneficiary_pub_key;
  }

  /**
   * Per-token-type derivation of the terminal `fee_beneficiary` spliced into
   * the warp transfer_remote fee section. Matches
   * `HyperlaneSealevelTokenPlugin::fee_beneficiary_pubkey` on chain.
   */
  protected abstract deriveFeeBeneficiary(
    beneficiaryOwner: PublicKey,
  ): Promise<PublicKey>;

  /**
   * Build the fee-section account list. Spliced into the warp transfer_remote
   * after the dispatched-message PDA, when `token.fee_config` is Some.
   *   [feeProgram, feeAccount, ...passThrough, feeBeneficiary(w)]
   *
   * `scopedSalt` (optional) is the pre-scoped 32-byte salt for an offchain
   * transient fee quote — when set, the on-chain cascade enumerator
   * (`GetQuoteAccountMetas`) returns the transient-quote PDA alongside the
   * standing path so a same-tx `SubmitFeeQuote` can deposit there. Standing-
   * only callers omit it.
   */
  protected async buildFeeSectionKeys({
    feeConfig,
    payer,
    destination,
    targetRouter,
    scopedSalt,
  }: {
    feeConfig: SealevelTokenFeeConfig;
    payer: PublicKey;
    destination: Domain;
    targetRouter: Uint8Array;
    scopedSalt?: Uint8Array;
  }): Promise<AccountMeta[]> {
    const metas = await simulateFeeQuoteAccountMetas(
      this.getProvider(),
      feeConfig.feeProgram,
      feeConfig.feeAccount,
      payer,
      { destinationDomain: destination, targetRouter, scopedSalt },
    );
    // Drop slots 0 (fee_account) and 1 (payer placeholder) — both appear
    // elsewhere in the warp transfer_remote tx.
    const passThrough = metas.slice(2);
    const beneficiaryOwner = await this.feeAccountBeneficiaryOwner.get();
    assert(
      beneficiaryOwner,
      'fee_account beneficiary owner unavailable; token.fee_config missing',
    );
    const feeBeneficiary = await this.deriveFeeBeneficiary(beneficiaryOwner);
    return [
      { pubkey: feeConfig.feeProgram, isSigner: false, isWritable: false },
      { pubkey: feeConfig.feeAccount, isSigner: false, isWritable: false },
      ...passThrough,
      { pubkey: feeBeneficiary, isSigner: false, isWritable: true },
    ];
  }

  /**
   * Build the quoted-mode IGP extension. Spliced into the IGP section between
   * the gas-payment PDA and the configured IGP account when the inner Igp
   * has `fee_config` set:
   *   [dispatchAuthority, warpProgramId, ...cascade]
   *
   * The dispatch authority is the warp's `invoke_signed` PDA at runtime; it
   * is NOT marked as a signer at the outer-instruction level.
   */
  protected async buildIgpQuotedSectionKeys({
    igpProgramId,
    innerIgpAccount,
    payer,
    destination,
    scopedSalt,
  }: {
    igpProgramId: PublicKey;
    innerIgpAccount: PublicKey;
    payer: PublicKey;
    destination: Domain;
    /**
     * Pre-scoped 32-byte salt for an offchain transient IGP quote. When set,
     * `GetIgpQuoteAccountMetas` returns the transient PDA in its cascade.
     * Forward-looking — SVM IGP doesn't accept offchain submits today.
     */
    scopedSalt?: Uint8Array;
  }): Promise<AccountMeta[]> {
    const igpMetas = await simulateIgpQuoteAccountMetas(
      this.getProvider(),
      igpProgramId,
      innerIgpAccount,
      payer,
      {
        destinationDomain: destination,
        sender: this.warpProgramPubKey,
        scopedSalt,
      },
    );
    // GetIgpQuoteAccountMetas returns the PayForGas-shaped list. We re-emit
    // the quoted-mode prefix from local state and use the simulation's tail
    // (slot 8+) for the cascade PDAs.
    return [
      {
        pubkey: this.deriveMessageDispatchAuthorityAccount(),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: this.warpProgramPubKey, isSigner: false, isWritable: false },
      ...igpMetas.slice(8),
    ];
  }

  private async loadTokenAccountData(): Promise<SealevelHyperlaneTokenData> {
    const tokenPda = this.deriveHypTokenAccount();
    const accountInfo = await this.getProvider().getAccountInfo(tokenPda);
    if (!accountInfo) throw new Error(`No account info found for ${tokenPda}`);
    const wrappedData = deserializeUnchecked(
      SealevelHyperlaneTokenDataSchema,
      SealevelAccountDataWrapper,
      accountInfo.data,
    );

    const data = wrappedData.data;
    assert(
      data instanceof SealevelHyperlaneTokenData,
      'Decoded wrapper.data is not SealevelHyperlaneTokenData',
    );

    const consumedSize = serialize(
      SealevelHyperlaneTokenDataSchema,
      wrappedData,
    ).length;
    data.fee_config = decodeTrailingFeeConfig(
      Buffer.from(accountInfo.data),
      consumedSize,
      this.pluginDataSize,
    );

    return data;
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
  async quoteTransferRemoteGas({
    destination,
    sender,
    recipient,
    amount,
  }: QuoteTransferRemoteParams): Promise<InterchainGasQuote> {
    return this.quoteTransferGas({
      destination,
      sender,
      recipient,
      amount,
      // Non-CC routes pass H256::zero() per the fee program's seed macros.
      targetRouter: new Uint8Array(32),
    });
  }

  /// Core quote orchestration shared by quoteTransferRemoteGas (non-CC) and
  /// quoteTransferRemoteToGas (CC override). `targetRouter` is the 32-byte
  /// H256 used in the fee program's standing-quote PDA seeds: H256::zero
  /// for Leaf / Routing modes, destination warp router for
  /// CrossCollateralRouting.
  protected async quoteTransferGas({
    destination,
    sender,
    recipient,
    amount,
    targetRouter,
  }: {
    destination: Domain;
    sender?: Address;
    recipient?: Address;
    amount?: bigint;
    targetRouter: Uint8Array;
  }): Promise<InterchainGasQuote> {
    const tokenData = await this.getTokenAccountData();

    // -------- Warp fee quote (only when token.fee_config is set) --------
    let tokenFeeQuote: Quote | undefined;
    if (tokenData.fee_config) {
      assert(
        sender && recipient && amount !== undefined,
        'sender, recipient, and amount required for Sealevel warp-fee quote',
      );
      tokenFeeQuote = await this.quoteWarpFee({
        feeConfig: tokenData.fee_config,
        payer: new PublicKey(sender),
        destination,
        recipient,
        amount,
        targetRouter,
      });
    }

    // -------- IGP fee quote --------
    const destinationGas = tokenData.destination_gas?.get(destination);
    let igpQuote: Quote = { amount: 0n };
    if (!isNullish(destinationGas)) {
      const igpAdapter = this.getIgpAdapter(tokenData);
      if (igpAdapter) {
        assert(
          sender,
          'Sender required for Sealevel transfer remote gas quote',
        );
        const senderPubKey = new PublicKey(sender);
        const igpState = await this.innerIgpFeeState.get();
        const igpProgramId =
          tokenData.interchain_gas_paymaster?.program_id_pubkey;
        if (igpState?.feeConfig && igpProgramId) {
          igpQuote = {
            amount: await this.quoteIgpNewFlow({
              igpProgramId,
              innerIgpAccount: igpState.innerIgpAccount,
              overheadIgpAccount: igpState.overheadIgpAccount,
              payer: senderPubKey,
              destination,
              gasAmount: destinationGas,
            }),
          };
        } else {
          igpQuote = {
            amount: await igpAdapter.quoteGasPayment(
              destination,
              destinationGas,
              senderPubKey,
            ),
          };
        }
      }
    }

    return tokenFeeQuote ? { igpQuote, tokenFeeQuote } : { igpQuote };
  }

  private async quoteWarpFee({
    feeConfig,
    payer,
    destination,
    recipient,
    amount,
    targetRouter,
  }: {
    feeConfig: SealevelTokenFeeConfig;
    payer: PublicKey;
    destination: Domain;
    recipient: Address;
    amount: bigint;
    targetRouter: Uint8Array;
  }): Promise<Quote> {
    const metas = await simulateFeeQuoteAccountMetas(
      this.getProvider(),
      feeConfig.feeProgram,
      feeConfig.feeAccount,
      payer,
      { destinationDomain: destination, targetRouter },
    );
    // Slot 1 of the simulation output is a payer placeholder
    // (Pubkey::default()) — substitute with the real payer before invoking
    // QuoteFee.
    const accounts = metas.map((m, i) =>
      i === 1 ? { ...m, pubkey: payer } : m,
    );
    const feeAmount = await simulateWarpFee(
      this.getProvider(),
      feeConfig.feeProgram,
      payer,
      accounts,
      {
        destinationDomain: destination,
        recipient: padBytesToLength(addressToBytes(recipient), 32),
        amount,
        targetRouter,
      },
    );
    return {
      amount: feeAmount,
      addressOrDenom: this.getFeeTokenAddressOrDenom(),
    };
  }

  private async quoteIgpNewFlow({
    igpProgramId,
    innerIgpAccount,
    overheadIgpAccount,
    payer,
    destination,
    gasAmount,
  }: {
    igpProgramId: PublicKey;
    innerIgpAccount: PublicKey;
    overheadIgpAccount?: PublicKey;
    payer: PublicKey;
    destination: Domain;
    gasAmount: bigint;
  }): Promise<bigint> {
    // Discover the standing cascade tail via on-chain simulation on the
    // inner Igp. simulateIgpQuoteAccountMetas returns the PayForGas-shaped
    // list; slots 0..7 are the static prefix, slot 8+ is the cascade.
    const igpMetas = await simulateIgpQuoteAccountMetas(
      this.getProvider(),
      igpProgramId,
      innerIgpAccount,
      payer,
      { destinationDomain: destination, sender: this.warpProgramPubKey },
    );
    const cascadeTail = igpMetas.slice(8);

    // QuoteGasPayment new-flow direct-call layout:
    //   [system, inner_igp, quoted_sender, ...cascade, optional_overhead_igp]
    const accounts: AccountMeta[] = [
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: innerIgpAccount, isSigner: false, isWritable: false },
      { pubkey: this.warpProgramPubKey, isSigner: false, isWritable: false },
      ...cascadeTail,
    ];
    if (overheadIgpAccount) {
      accounts.push({
        pubkey: overheadIgpAccount,
        isSigner: false,
        isWritable: false,
      });
    }

    return simulateIgpQuote(this.getProvider(), igpProgramId, payer, accounts, {
      destinationDomain: destination,
      gasAmount,
    });
  }

  /**
   * Sealevel-only — returns the building blocks of a `transfer_remote` tx
   * (compute-budget ixs separated from the warp ix, ALTs, fee payer, the
   * randomWallet signer) without compiling them into a `Transaction` /
   * `VersionedTransaction`. The composing layer (typically the offchain-
   * quoted-transfer provider) prepends `SubmitFeeQuote` / `SubmitIgpQuote`
   * ixs between the compute-budget head and the transfer ix.
   *
   * `clientSalt` (optional) is the pre-scoped 32-byte salt for a same-tx
   * offchain transient quote — threaded through to the fee + IGP cascade
   * simulations so their PDA enumeration includes the transient quote PDA.
   * Standing-only callers omit it.
   *
   * `populateTransferRemoteTx` wraps this with a blockhash fetch + tx
   * compilation; provider-level composition uses the bundle directly.
   */
  async getTransferRemoteIxBundle({
    weiAmountOrId,
    destination,
    recipient,
    fromAccountOwner,
    extraSigners,
    clientSalt,
  }: TransferRemoteParams & {
    /** Sealevel-only — see method docs. */
    clientSalt?: Uint8Array;
  }): Promise<SealevelTransferBundle> {
    if (!fromAccountOwner)
      throw new Error('fromAccountOwner required for Sealevel');
    const randomWallet = extraSigners?.length
      ? extraSigners[0]
      : Keypair.generate();
    const fromWalletPubKey = new PublicKey(fromAccountOwner);
    const mailboxPubKey = new PublicKey(this.addresses.mailbox);

    const tokenData = await this.getTokenAccountData();
    const igpState = await this.innerIgpFeeState.get();

    // The non-CC `transfer_remote` CPIs `QuoteFee` with
    // `target_router = token.router(destination_domain)` (i.e. the enrolled
    // remote router, see hyperlane-sealevel-token's `transfer_remote`). The
    // fee program's CC-routing variant keys its specific-scope standing PDA
    // off `data.target_router`, so the cascade simulation here must use the
    // same router bytes the runtime CPI will pass — otherwise the simulated
    // PDA slot at `(dest, ZERO)` mismatches the runtime expectation at
    // `(dest, enrolled_router)` and `process_quote_fee` errors with
    // `InvalidTransientSlot`. Non-CC fee variants (Leaf / Routing) ignore
    // `data.target_router` (the on-chain `standing_target_router = ZERO`
    // arm fires), so passing the enrolled router is a no-op for them.
    const feeSection = tokenData.fee_config
      ? await this.buildFeeSectionKeys({
          feeConfig: tokenData.fee_config,
          payer: fromWalletPubKey,
          destination,
          targetRouter: new Uint8Array(
            await this.getRouterAddress(destination),
          ),
          scopedSalt: clientSalt,
        })
      : undefined;

    const igpProgramId = tokenData.interchain_gas_paymaster?.program_id_pubkey;
    const igpQuotedSection =
      igpState?.feeConfig && igpProgramId
        ? await this.buildIgpQuotedSectionKeys({
            igpProgramId,
            innerIgpAccount: igpState.innerIgpAccount,
            payer: fromWalletPubKey,
            destination,
            scopedSalt: clientSalt,
          })
        : undefined;

    const keys = await this.getTransferInstructionKeyList({
      sender: fromWalletPubKey,
      mailbox: mailboxPubKey,
      randomWallet: randomWallet.publicKey,
      igp: await this.getIgpKeys(),
      feeSection,
      igpQuotedSection,
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

    const addressLookupTableAccounts = this.addresses.altAddresses
      ? await this.addressLookupTableAccounts.get()
      : [];

    return {
      computeBudgetInstructions: [
        setComputeLimitInstruction,
        setPriorityFeeInstruction,
      ],
      transferInstructions: [transferRemoteInstruction],
      addressLookupTableAccounts,
      feePayer: fromWalletPubKey,
      signers: [randomWallet],
    };
  }

  async populateTransferRemoteTx(
    params: TransferRemoteParams,
  ): Promise<Transaction | VersionedTransaction> {
    const bundle = await this.getTransferRemoteIxBundle(params);
    const allInstructions = [
      ...bundle.computeBudgetInstructions,
      ...bundle.transferInstructions,
    ];

    const recentBlockhash = (
      await this.getProvider().getLatestBlockhash('finalized')
    ).blockhash;

    if (this.addresses.altAddresses) {
      // ALT path: when the route registers ALT addresses, compile a v0
      // message so the on-chain account-key list stays under Solana's
      // 1232-byte tx limit (40+ accounts on new-flow fee + IGP routes).
      const message = MessageV0.compile({
        payerKey: bundle.feePayer,
        instructions: allInstructions,
        recentBlockhash,
        addressLookupTableAccounts: bundle.addressLookupTableAccounts,
      });
      const versionedTx = new VersionedTransaction(message);
      // Only fills the randomWallet's slot; the user wallet's slot stays
      // empty for the wallet-adapter chain to populate later.
      versionedTx.sign(bundle.signers);
      return versionedTx;
    }

    // Legacy path — unchanged for routes without ALT.
    // @ts-ignore Workaround for bug in the web3 lib, sometimes uses recentBlockhash and sometimes uses blockhash
    const tx = new Transaction({
      feePayer: bundle.feePayer,
      blockhash: recentBlockhash,
      recentBlockhash,
    });
    for (const ix of allInstructions) tx.add(ix);
    for (const signer of bundle.signers) tx.partialSign(signer);
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
    feeSection,
    igpQuotedSection,
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
    // Fee section — spliced when token.fee_config is Some on chain.
    if (feeSection) {
      keys = [...keys, ...feeSection];
    }
    if (igp) {
      keys = [
        ...keys,
        // [executable] The IGP program.
        { pubkey: igp.programId, isSigner: false, isWritable: false },
        // [writeable] The IGP program data.
        {
          pubkey: SealevelOverheadIgpAdapter.deriveIgpProgramPda(igp.programId),
          isSigner: false,
          isWritable: true,
        },
        // [writeable] Gas payment PDA.
        {
          pubkey: SealevelOverheadIgpAdapter.deriveGasPaymentPda(
            igp.programId,
            randomWallet,
          ),
          isSigner: false,
          isWritable: true,
        },
      ];
      // Quoted-mode extension — spliced when the inner Igp has fee_config Some
      // on chain. Placed BEFORE the optional overhead IGP and the terminal
      // configured IGP, matching the on-chain transfer_remote layout.
      if (igpQuotedSection) {
        keys = [...keys, ...igpQuotedSection];
      }
      if (igp.overheadIgpAccount) {
        keys = [
          ...keys,
          // [] OPTIONAL - The Overhead IGP account, if the configured IGP is an Overhead IGP
          {
            pubkey: igp.overheadIgpAccount,
            isSigner: false,
            isWritable: false,
          },
        ];
      }
      keys = [
        ...keys,
        // [writeable] The Overhead's inner IGP account (or the normal IGP account if there's no Overhead IGP).
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
  // NativePlugin = [u8 native_collateral_bump]. Matches
  // rust/sealevel/programs/hyperlane-sealevel-token-native/src/plugin.rs.
  protected readonly pluginDataSize = 1;
  public readonly wrappedNative: SealevelNativeTokenAdapter;

  // Native warp fees are deducted from the native collateral PDA → SOL.
  protected override getFeeTokenAddressOrDenom(): string | undefined {
    return undefined;
  }

  // Native fee_beneficiary = beneficiary wallet directly (lamports recipient).
  protected override async deriveFeeBeneficiary(
    beneficiaryOwner: PublicKey,
  ): Promise<PublicKey> {
    return beneficiaryOwner;
  }

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProviderAdapter,
    addresses: {
      // A 'token' address is not required for hyp native tokens (e.g. hypSOL)
      token?: Address;
      warpRouter: Address;
      mailbox: Address;
      altAddresses?: SealevelAltAddresses;
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
  // CollateralPlugin = [Pubkey spl_token_program, Pubkey mint, Pubkey escrow,
  // u8 escrow_bump, u8 ata_payer_bump]. Matches
  // rust/sealevel/programs/hyperlane-sealevel-token-collateral/src/plugin.rs.
  protected readonly pluginDataSize = 98;

  // Collateral fee_beneficiary = ATA(beneficiary_owner, mint, spl_token_program).
  protected override async deriveFeeBeneficiary(
    beneficiaryOwner: PublicKey,
  ): Promise<PublicKey> {
    return getAssociatedTokenAddressSync(
      this.tokenMintPubKey,
      beneficiaryOwner,
      false,
      await this.getTokenProgramId(),
    );
  }

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
  // SyntheticPlugin = [Pubkey mint, u8 mint_bump, u8 ata_payer_bump]. Matches
  // rust/sealevel/programs/hyperlane-sealevel-token/src/plugin.rs.
  protected readonly pluginDataSize = 34;

  // Synthetic fee_beneficiary = ATA(beneficiary_owner, synthetic_mint, token_2022).
  protected override async deriveFeeBeneficiary(
    beneficiaryOwner: PublicKey,
  ): Promise<PublicKey> {
    return getAssociatedTokenAddressSync(
      this.deriveMintAuthorityAccount(),
      beneficiaryOwner,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
  }

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
  /**
   * Optional fee section spliced after the dispatched-message PDA when the
   * token has `fee_config` set. Layout:
   *   [feeProgram, feeAccount, ...passThrough, feeBeneficiary(w)]
   */
  feeSection?: AccountMeta[];
  /**
   * Optional quoted-mode IGP extension spliced between the gas-payment PDA
   * and the configured IGP account when the inner Igp has `fee_config` set:
   *   [dispatchAuthority, warpProgramId, ...cascade]
   */
  igpQuotedSection?: AccountMeta[];
}
