import {
  AccountMeta,
  ComputeBudgetProgram,
  Message,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { deserializeUnchecked, serialize } from 'borsh';

import { Address, Domain, assert } from '@hyperlane-xyz/utils';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp.js';
import { SEALEVEL_PRIORITY_FEES } from '../../consts/sealevel.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import {
  SealevelAccountDataWrapper,
  SealevelInstructionWrapper,
} from '../../utils/sealevelSerialization.js';

import {
  SealeveIgpInstruction,
  SealevelIgpData,
  SealevelIgpDataSchema,
  SealevelIgpQuoteGasPaymentInstruction,
  SealevelIgpQuoteGasPaymentResponse,
  SealevelIgpQuoteGasPaymentResponseSchema,
  SealevelIgpQuoteGasPaymentSchema,
  SealevelOverheadIgpData,
  SealevelOverheadIgpDataSchema,
} from './serialization.js';

export interface IgpPaymentKeys {
  programId: PublicKey;
  igpAccount: PublicKey;
  overheadIgpAccount?: PublicKey;
}

export abstract class SealevelIgpProgramAdapter extends BaseSealevelAdapter {
  protected readonly programId: PublicKey;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { programId: Address },
  ) {
    super(chainName, multiProvider, addresses);

    this.programId = new PublicKey(addresses.programId);
  }

  abstract getPaymentKeys(): Promise<IgpPaymentKeys>;

  // Simulating a transaction requires a payer to have sufficient balance to pay for tx fees.
  async quoteGasPayment(
    destination: Domain,
    gasAmount: bigint,
    payerKey: PublicKey,
  ): Promise<bigint> {
    const paymentKeys = await this.getPaymentKeys();
    const keys = [
      // 0. `[executable]` The system program.
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // 1. `[]` The IGP account.
      {
        pubkey: paymentKeys.igpAccount,
        isSigner: false,
        isWritable: false,
      },
    ];
    if (paymentKeys.overheadIgpAccount) {
      // 2. `[]` The overhead IGP account (optional).
      keys.push({
        pubkey: paymentKeys.overheadIgpAccount,
        isSigner: false,
        isWritable: false,
      });
    }
    const value = new SealevelInstructionWrapper({
      instruction: SealeveIgpInstruction.QuoteGasPayment,
      data: new SealevelIgpQuoteGasPaymentInstruction({
        destination_domain: destination,
        gas_amount: BigInt(gasAmount),
      }),
    });
    const quoteGasPaymentInstruction = new TransactionInstruction({
      keys,
      programId: this.programId,
      data: Buffer.from(serialize(SealevelIgpQuoteGasPaymentSchema, value)),
    });

    const message = Message.compile({
      // This is ignored
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [quoteGasPaymentInstruction],
      payerKey,
    });

    const tx = new VersionedTransaction(message);

    const connection = this.getProvider();
    const simulationResponse = await connection.simulateTransaction(tx, {
      // ignore the recent blockhash we pass in, and have the node use its latest one
      replaceRecentBlockhash: true,
      // ignore signature verification
      sigVerify: false,
    });

    const base64Data = simulationResponse.value.returnData?.data?.[0];
    assert(
      base64Data,
      'No return data when quoting gas payment, may happen if the payer has insufficient funds',
    );

    const data = Buffer.from(base64Data, 'base64');
    const quote = deserializeUnchecked(
      SealevelIgpQuoteGasPaymentResponseSchema,
      SealevelIgpQuoteGasPaymentResponse,
      data,
    );

    return quote.payment_quote;
  }

  // https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/hyperlane-sealevel-igp/src/pda_seeds.rs#L7
  static deriveIgpProgramPda(igpProgramId: string | PublicKey): PublicKey {
    return super.derivePda(
      ['hyperlane_igp', '-', 'program_data'],
      igpProgramId,
    );
  }

  // https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/hyperlane-sealevel-igp/src/pda_seeds.rs#L62
  static deriveGasPaymentPda(
    igpProgramId: string | PublicKey,
    randomWalletPubKey: PublicKey,
  ): PublicKey {
    return super.derivePda(
      ['hyperlane_igp', '-', 'gas_payment', '-', randomWalletPubKey.toBuffer()],
      igpProgramId,
    );
  }
}

export class SealevelIgpAdapter extends SealevelIgpProgramAdapter {
  protected readonly igp: PublicKey;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { igp: Address; programId: Address },
  ) {
    super(chainName, multiProvider, addresses);

    this.igp = new PublicKey(addresses.igp);
  }

  override async getPaymentKeys(): Promise<IgpPaymentKeys> {
    return {
      programId: this.programId,
      igpAccount: this.igp,
    };
  }

  async getAccountInfo(): Promise<SealevelIgpData> {
    const address = this.addresses.igp;
    const connection = this.getProvider();

    const accountInfo = await connection.getAccountInfo(new PublicKey(address));
    assert(accountInfo, `No account info found for ${address}}`);

    const accountData = deserializeUnchecked(
      SealevelIgpDataSchema,
      SealevelAccountDataWrapper,
      accountInfo.data,
    );
    return accountData.data as SealevelIgpData;
  }

  // Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/hyperlane-sealevel-igp/src/processor.rs#L536-L581
  getClaimInstructionKeyList(beneficiary: PublicKey): Array<AccountMeta> {
    return [
      // 0. [executable] The system program.
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // 1. [writeable] The IGP account.
      { pubkey: this.igp, isSigner: false, isWritable: true },
      // 2. [writeable] The IGP beneficiary.
      { pubkey: beneficiary, isSigner: false, isWritable: true },
    ];
  }

  /**
   * Constructs a Transaction for .
   * @param {PublicKey} beneficiary - The IGP's configured beneficiary.
   * @returns {Promise<TransactionInstruction>} The claim instruction.
   */
  async populateClaimTx(beneficiary: PublicKey): Promise<Transaction> {
    const igpData = await this.getAccountInfo();

    // check if the passed in beneficiary is same as stored beneficiary
    if (!igpData.beneficiary_pub_key.equals(beneficiary)) {
      throw new Error('Beneficiary account mismatch');
    }

    const keys = this.getClaimInstructionKeyList(beneficiary);
    const data = Buffer.from([SealeveIgpInstruction.Claim]);

    const claimIgpInstruction = new TransactionInstruction({
      keys,
      programId: this.programId,
      data: data,
    });

    // Set priority fee if available in config
    const priorityFee = SEALEVEL_PRIORITY_FEES[this.chainName];
    const setPriorityFeeInstruction = priorityFee
      ? ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFee,
        })
      : undefined;

    const transaction = new Transaction();
    if (setPriorityFeeInstruction) {
      transaction.add(setPriorityFeeInstruction);
    }
    transaction.add(claimIgpInstruction);
    return transaction;
  }
}

export class SealevelOverheadIgpAdapter extends SealevelIgpProgramAdapter {
  protected readonly overheadIgp: PublicKey;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { overheadIgp: Address; programId: Address },
  ) {
    super(chainName, multiProvider, addresses);

    this.overheadIgp = new PublicKey(addresses.overheadIgp);
  }

  async getAccountInfo(): Promise<SealevelOverheadIgpData> {
    const address = this.addresses.overheadIgp;
    const connection = this.getProvider();

    const accountInfo = await connection.getAccountInfo(new PublicKey(address));
    assert(accountInfo, `No account info found for ${address}}`);

    const accountData = deserializeUnchecked(
      SealevelOverheadIgpDataSchema,
      SealevelAccountDataWrapper,
      accountInfo.data,
    );
    return accountData.data as SealevelOverheadIgpData;
  }

  override async getPaymentKeys(): Promise<IgpPaymentKeys> {
    const igpData = await this.getAccountInfo();
    return {
      programId: this.programId,
      igpAccount: igpData.inner_pub_key,
      overheadIgpAccount: this.overheadIgp,
    };
  }
}
