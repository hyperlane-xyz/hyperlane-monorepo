import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
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
  eqAddress,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp.js';
import { SEALEVEL_SPL_NOOP_ADDRESS } from '../../consts/sealevel.js';
import { SealevelOverheadIgpAdapter } from '../../gas/adapters/SealevelIgpAdapter.js';
import { SealevelInterchainGasPaymasterType } from '../../gas/adapters/serialization.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import {
  SealevelAccountDataWrapper,
  SealevelInstructionWrapper,
} from '../../utils/sealevelSerialization.js';
import { MinimalTokenMetadata } from '../config.js';

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

// author @tkporter @jmrossy
// Interacts with native currencies
export class SealevelNativeTokenAdapter
  extends BaseSealevelAdapter
  implements ITokenAdapter<Transaction>
{
  async getBalance(address: Address): Promise<bigint> {
    const balance = await this.getProvider().getBalance(new PublicKey(address));
    return BigInt(balance.toString());
  }

  async getMetadata(): Promise<MinimalTokenMetadata> {
    throw new Error('Metadata not available to native tokens');
  }

  async isApproveRequired(): Promise<boolean> {
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
}

// Interacts with SPL token programs
export class SealevelTokenAdapter
  extends BaseSealevelAdapter
  implements ITokenAdapter<Transaction>
{
  public readonly tokenProgramPubKey: PublicKey;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
    public readonly isSpl2022: boolean = false,
  ) {
    super(chainName, multiProvider, addresses);
    this.tokenProgramPubKey = new PublicKey(addresses.token);
  }

  async getBalance(owner: Address): Promise<bigint> {
    const tokenPubKey = this.deriveAssociatedTokenAccount(new PublicKey(owner));
    const response = await this.getProvider().getTokenAccountBalance(
      tokenPubKey,
    );
    return BigInt(response.value.amount);
  }

  async getMetadata(_isNft?: boolean): Promise<MinimalTokenMetadata> {
    // TODO solana support
    return { decimals: 9, symbol: 'SPL', name: 'SPL Token' };
  }

  async isApproveRequired(): Promise<boolean> {
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

  getTokenProgramId(): PublicKey {
    return this.isSpl2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  }

  deriveAssociatedTokenAccount(owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.tokenProgramPubKey,
      owner,
      true,
      this.getTokenProgramId(),
    );
  }
}

// The compute limit to set for the transfer remote instruction.
// This is typically around ~160k, but can be higher depending on
// the index in the merkle tree, which can result in more moderately
// more expensive merkle tree insertion.
// Because a higher compute limit doesn't increase the fee for a transaction,
// we generously request 1M units.
const TRANSFER_REMOTE_COMPUTE_LIMIT = 1_000_000;

export abstract class SealevelHypTokenAdapter
  extends SealevelTokenAdapter
  implements IHypTokenAdapter<Transaction>
{
  public readonly warpProgramPubKey: PublicKey;
  protected cachedTokenAccountData: SealevelHyperlaneTokenData | undefined;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: {
      token: Address;
      warpRouter: Address;
      mailbox: Address;
    },
    public readonly isSpl2022: boolean = false,
  ) {
    // Pass in placeholder address to avoid errors for native token addresses (which as represented here as 0s)
    const superTokenProgramId = isZeroishAddress(addresses.token)
      ? SystemProgram.programId.toBase58()
      : addresses.token;
    super(chainName, multiProvider, { token: superTokenProgramId }, isSpl2022);
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

  override async getMetadata(): Promise<MinimalTokenMetadata> {
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

  async quoteTransferRemoteGas(
    _destination: Domain,
  ): Promise<InterchainGasQuote> {
    // TODO Solana support
    return { amount: 0n };
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

    const keys = this.getTransferInstructionKeyList({
      sender: fromWalletPubKey,
      mailbox: mailboxPubKey,
      randomWallet: randomWallet.publicKey,
      igp: await this.getIgpKeys(),
    });

    const value = new SealevelInstructionWrapper({
      instruction: SealevelHypTokenInstruction.TransferRemote,
      data: new SealevelTransferRemoteInstruction({
        destination_domain: destination,
        recipient: addressToBytes(recipient),
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
      {
        units: TRANSFER_REMOTE_COMPUTE_LIMIT,
      },
    );

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
      .add(transferRemoteInstruction);
    tx.partialSign(randomWallet);
    return tx;
  }

  async getIgpKeys(): Promise<KeyListParams['igp']> {
    const tokenData = await this.getTokenAccountData();
    if (!tokenData.interchain_gas_paymaster) return undefined;
    const igpConfig = tokenData.interchain_gas_paymaster;
    if (igpConfig.type === SealevelInterchainGasPaymasterType.Igp) {
      return {
        programId: igpConfig.program_id_pubkey,
      };
    } else if (
      igpConfig.type === SealevelInterchainGasPaymasterType.OverheadIgp
    ) {
      if (!igpConfig.igp_account_pub_key) {
        throw new Error('igpAccount field expected for Sealevel Overhead IGP');
      }
      const overheadAdapter = new SealevelOverheadIgpAdapter(
        this.chainName,
        this.multiProvider,
        { igp: igpConfig.igp_account_pub_key.toBase58() },
      );
      const overheadAccountInfo = await overheadAdapter.getAccountInfo();
      return {
        programId: igpConfig.program_id_pubkey,
        igpAccount: igpConfig.igp_account_pub_key,
        innerIgpAccount: overheadAccountInfo.inner_pub_key,
      };
    } else {
      throw new Error(`Unsupported IGP type ${igpConfig.type}`);
    }
  }

  // Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/libraries/hyperlane-sealevel-token/src/processor.rs#L257-L274
  getTransferInstructionKeyList({
    sender,
    mailbox,
    randomWallet,
    igp,
  }: KeyListParams): Array<AccountMeta> {
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
      if (igp.igpAccount && igp.innerIgpAccount) {
        keys = [
          ...keys,
          // 12.   [] OPTIONAL - The Overhead IGP account, if the configured IGP is an Overhead IGP
          {
            pubkey: igp.igpAccount,
            isSigner: false,
            isWritable: false,
          },
          // 13.   [writeable] The Overhead's inner IGP account
          {
            pubkey: igp.innerIgpAccount,
            isSigner: false,
            isWritable: true,
          },
        ];
      } else {
        keys = [
          ...keys,
          // 12.   [writeable] The IGP account.
          {
            pubkey: igp.programId,
            isSigner: false,
            isWritable: true,
          },
        ];
      }
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
}

// Interacts with Hyp Native token programs
export class SealevelHypNativeAdapter extends SealevelHypTokenAdapter {
  public readonly wrappedNative: SealevelNativeTokenAdapter;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: {
      token: Address;
      warpRouter: Address;
      mailbox: Address;
    },
    public readonly isSpl2022: boolean = false,
  ) {
    super(chainName, multiProvider, addresses, isSpl2022);
    this.wrappedNative = new SealevelNativeTokenAdapter(
      chainName,
      multiProvider,
      {},
    );
  }

  override async getBalance(owner: Address): Promise<bigint> {
    return this.wrappedNative.getBalance(owner);
  }

  override async getMetadata(): Promise<MinimalTokenMetadata> {
    return this.wrappedNative.getMetadata();
  }

  getTransferInstructionKeyList(params: KeyListParams): Array<AccountMeta> {
    return [
      ...super.getTransferInstructionKeyList(params),
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
      const response = await this.getProvider().getTokenAccountBalance(
        collateralAccount,
      );
      return BigInt(response.value.amount);
    }

    return super.getBalance(owner);
  }

  override getTransferInstructionKeyList(
    params: KeyListParams,
  ): Array<AccountMeta> {
    return [
      ...super.getTransferInstructionKeyList(params),
      /// 9.   [executable] The SPL token program for the mint.
      { pubkey: this.getTokenProgramId(), isSigner: false, isWritable: false },
      /// 10.  [writeable] The mint.
      { pubkey: this.tokenProgramPubKey, isSigner: false, isWritable: true },
      /// 11.  [writeable] The token sender's associated token account, from which tokens will be sent.
      {
        pubkey: this.deriveAssociatedTokenAccount(params.sender),
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
  override getTransferInstructionKeyList(
    params: KeyListParams,
  ): Array<AccountMeta> {
    return [
      ...super.getTransferInstructionKeyList(params),
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
        pubkey: this.deriveAssociatedTokenAccount(params.sender),
        isSigner: false,
        isWritable: true,
      },
    ];
  }

  override async getBalance(owner: Address): Promise<bigint> {
    const tokenPubKey = this.deriveAssociatedTokenAccount(new PublicKey(owner));
    const response = await this.getProvider().getTokenAccountBalance(
      tokenPubKey,
    );
    return BigInt(response.value.amount);
  }

  deriveMintAuthorityAccount(): PublicKey {
    return super.derivePda(
      ['hyperlane_token', '-', 'mint'],
      this.warpProgramPubKey,
    );
  }

  override deriveAssociatedTokenAccount(owner: PublicKey): PublicKey {
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
  igp?: {
    programId: PublicKey;
    igpAccount?: PublicKey;
    innerIgpAccount?: PublicKey;
  };
}
