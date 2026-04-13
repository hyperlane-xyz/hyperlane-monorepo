import { createHash } from 'node:crypto';

import {
  publicKey as umiPublicKey,
  type Option,
  type OptionOrNullable,
  type RpcInterface,
} from '@metaplex-foundation/umi';
import {
  array,
  bool,
  bytes,
  option,
  string as stringSerializer,
  struct,
  type Serializer,
  u32,
  u64,
} from '@metaplex-foundation/umi/serializers';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  TransactionInstruction,
  VersionedTransaction,
  type AccountMeta,
} from '@solana/web3.js';

import { assert } from '@hyperlane-xyz/utils';
import {
  SendHelper,
  instructionDiscriminator,
} from '@layerzerolabs/lz-solana-sdk-v2/umi';

const COMPUTE_UNIT_LIMIT = 1_000_000;
const OFT_SEED = Buffer.from('OFT', 'utf8');
const CREDITS_SEED = Buffer.from('Credits', 'utf8');
const PEER_SEED = Buffer.from('Peer', 'utf8');
const EVENT_AUTHORITY_SEED = Buffer.from('__event_authority', 'utf8');
const QUOTE_OFT_DISCRIMINATOR = instructionDiscriminator('quote_oft');
const QUOTE_SEND_DISCRIMINATOR = instructionDiscriminator('quote_send');
const SEND_DISCRIMINATOR = instructionDiscriminator('send');
const OFT_STORE_ACCOUNT_DISCRIMINATOR =
  getAnchorAccountDiscriminator('OFTStore');
const PEER_CONFIG_ACCOUNT_DISCRIMINATOR =
  getAnchorAccountDiscriminator('PeerConfig');
const CREDITS_ACCOUNT_DISCRIMINATOR = getAnchorAccountDiscriminator('Credits');

type Usdt0QuoteInstructionData = {
  discriminator: Uint8Array;
  dstEid: number;
  to: Uint8Array;
  amountLd: bigint;
  minAmountLd: bigint;
  options: Uint8Array;
  composeMsg: Option<Uint8Array>;
  payInLzToken: boolean;
};

type Usdt0QuoteInstructionDataArgs = Omit<
  Usdt0QuoteInstructionData,
  'discriminator' | 'composeMsg'
> & {
  composeMsg: OptionOrNullable<Uint8Array>;
};

type Usdt0SendInstructionData = {
  discriminator: Uint8Array;
  dstEid: number;
  to: Uint8Array;
  amountLd: bigint;
  minAmountLd: bigint;
  options: Uint8Array;
  composeMsg: Option<Uint8Array>;
  nativeFee: bigint;
  lzTokenFee: bigint;
};

type Usdt0SendInstructionDataArgs = Omit<
  Usdt0SendInstructionData,
  'discriminator' | 'composeMsg'
> & {
  composeMsg: OptionOrNullable<Uint8Array>;
};

export type Usdt0OftFeeDetail = {
  feeAmountLd: bigint;
  description: string;
};

export type Usdt0QuoteOftResult = {
  oftLimits: {
    minAmountLd: bigint;
    maxAmountLd: bigint;
  };
  oftFeeDetails: Array<Usdt0OftFeeDetail>;
  oftReceipt: {
    amountSentLd: bigint;
    amountReceivedLd: bigint;
  };
};

export type Usdt0QuoteParams = {
  dstEid: number;
  to: Uint8Array;
  amountLd: bigint;
  minAmountLd: bigint;
  options?: Uint8Array;
  composeMsg?: Uint8Array;
  payInLzToken?: boolean;
};

export type Usdt0SendParams = Omit<Usdt0QuoteParams, 'payInLzToken'> & {
  nativeFee: bigint;
  lzTokenFee: bigint;
};

export type Usdt0OftStoreAccount = {
  tokenMint: PublicKey;
  tokenEscrow: PublicKey;
  endpointProgram: PublicKey;
  bump: number;
  feeBalance: bigint;
  superAdmin: PublicKey;
  planner: PublicKey;
  lpAdmin: PublicKey;
  burnAndNilifyAdmin: PublicKey;
  feeBps: number;
  lookupTable?: PublicKey;
};

export type ResolvedUsdt0MeshAccounts = {
  programId: PublicKey;
  oftStore: PublicKey;
  credits: PublicKey;
  peer: PublicKey;
  eventAuthority: PublicKey;
  tokenMint: PublicKey;
  tokenEscrow: PublicKey;
  endpointProgram: PublicKey;
  peerAddress: Uint8Array;
  lookupTable?: PublicKey;
};

type QuoteInstructionAccounts = Pick<
  ResolvedUsdt0MeshAccounts,
  'oftStore' | 'credits' | 'peer'
>;

type SendInstructionAccounts = Pick<
  ResolvedUsdt0MeshAccounts,
  'peer' | 'oftStore' | 'credits' | 'eventAuthority'
> & {
  signer: PublicKey;
  tokenSource: PublicKey;
  tokenEscrow: PublicKey;
  tokenMint: PublicKey;
  tokenProgram?: PublicKey;
};

function getAnchorAccountDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

function encodeDstEid(dstEid: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(dstEid);
  return buffer;
}

function readPublicKey(data: Uint8Array, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

function assertAccountDiscriminator(
  data: Uint8Array,
  expected: Buffer,
  accountName: string,
) {
  const actual = Buffer.from(data.subarray(0, 8));
  assert(
    actual.equals(expected),
    `Expected ${accountName} discriminator ${expected.toString('hex')}, got ${actual.toString('hex')}`,
  );
}

function normalizeQuoteParams(
  params: Usdt0QuoteParams,
): Usdt0QuoteInstructionDataArgs {
  assert(
    params.to.length === 32,
    `Expected 32-byte recipient, got ${params.to.length}`,
  );
  return {
    dstEid: params.dstEid,
    to: params.to,
    amountLd: params.amountLd,
    minAmountLd: params.minAmountLd,
    options: params.options ?? new Uint8Array(),
    composeMsg: params.composeMsg ?? null,
    payInLzToken: params.payInLzToken ?? false,
  };
}

function normalizeSendParams(
  params: Usdt0SendParams,
): Usdt0SendInstructionDataArgs {
  assert(
    params.to.length === 32,
    `Expected 32-byte recipient, got ${params.to.length}`,
  );
  return {
    dstEid: params.dstEid,
    to: params.to,
    amountLd: params.amountLd,
    minAmountLd: params.minAmountLd,
    options: params.options ?? new Uint8Array(),
    composeMsg: params.composeMsg ?? null,
    nativeFee: params.nativeFee,
    lzTokenFee: params.lzTokenFee,
  };
}

function toWeb3AccountMeta(meta: {
  pubkey: string | PublicKey;
  isSigner: boolean;
  isWritable: boolean;
}): AccountMeta {
  return {
    pubkey:
      meta.pubkey instanceof PublicKey
        ? meta.pubkey
        : new PublicKey(meta.pubkey),
    isSigner: meta.isSigner,
    isWritable: meta.isWritable,
  };
}

function getQuoteInstructionSerializer(): Serializer<
  Usdt0QuoteInstructionDataArgs,
  Usdt0QuoteInstructionDataArgs
> {
  return struct<Usdt0QuoteInstructionDataArgs>(
    [
      ['dstEid', u32()],
      ['to', bytes({ size: 32 })],
      ['amountLd', u64()],
      ['minAmountLd', u64()],
      ['options', bytes({ size: u32() })],
      ['composeMsg', option(bytes({ size: u32() }))],
      ['payInLzToken', bool()],
    ],
    { description: 'Usdt0QuoteInstructionDataArgs' },
  );
}

function getSendInstructionSerializer(): Serializer<
  Usdt0SendInstructionDataArgs,
  Usdt0SendInstructionDataArgs
> {
  return struct<Usdt0SendInstructionDataArgs>(
    [
      ['dstEid', u32()],
      ['to', bytes({ size: 32 })],
      ['amountLd', u64()],
      ['minAmountLd', u64()],
      ['options', bytes({ size: u32() })],
      ['composeMsg', option(bytes({ size: u32() }))],
      ['nativeFee', u64()],
      ['lzTokenFee', u64()],
    ],
    { description: 'Usdt0SendInstructionDataArgs' },
  );
}

function getQuoteOftResultSerializer(): Serializer<
  Usdt0QuoteOftResult,
  Usdt0QuoteOftResult
> {
  return struct<Usdt0QuoteOftResult>(
    [
      [
        'oftLimits',
        struct<Usdt0QuoteOftResult['oftLimits']>([
          ['minAmountLd', u64()],
          ['maxAmountLd', u64()],
        ]),
      ],
      [
        'oftFeeDetails',
        array(
          struct<Usdt0OftFeeDetail>([
            ['feeAmountLd', u64()],
            ['description', stringSerializer()],
          ]),
        ),
      ],
      [
        'oftReceipt',
        struct<Usdt0QuoteOftResult['oftReceipt']>([
          ['amountSentLd', u64()],
          ['amountReceivedLd', u64()],
        ]),
      ],
    ],
    { description: 'Usdt0QuoteOftResult' },
  );
}

function getMessagingFeeSerializer(): Serializer<
  { nativeFee: bigint; lzTokenFee: bigint },
  { nativeFee: bigint; lzTokenFee: bigint }
> {
  return struct(
    [
      ['nativeFee', u64()],
      ['lzTokenFee', u64()],
    ],
    { description: 'MessagingFee' },
  );
}

async function buildVersionedTransaction(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  blockhash?: string,
  lookupTableAddresses?: PublicKey | PublicKey[],
): Promise<VersionedTransaction> {
  const recentBlockhash =
    blockhash ?? (await connection.getLatestBlockhash('confirmed')).blockhash;
  const message = new TransactionMessage({
    instructions,
    payerKey: payer,
    recentBlockhash,
  });

  if (!lookupTableAddresses) {
    return new VersionedTransaction(message.compileToV0Message());
  }

  const tableAddresses = Array.isArray(lookupTableAddresses)
    ? lookupTableAddresses
    : [lookupTableAddresses];
  const tableInfos = await connection.getMultipleAccountsInfo(tableAddresses);
  const lookupTables = tableInfos
    .map((accountInfo, index) => {
      if (!accountInfo) return undefined;
      return new AddressLookupTableAccount({
        key: tableAddresses[index],
        state: AddressLookupTableAccount.deserialize(accountInfo.data),
      });
    })
    .filter((value): value is AddressLookupTableAccount => value !== undefined);

  return new VersionedTransaction(
    message.compileToV0Message(lookupTables.length ? lookupTables : undefined),
  );
}

async function simulateProgramReturn<From, To extends From = From>(
  connection: Connection,
  instructions: TransactionInstruction[],
  programId: PublicKey,
  payer: PublicKey,
  serializer: Serializer<From, To>,
  lookupTableAddresses?: PublicKey | PublicKey[],
): Promise<To> {
  const tx = await buildVersionedTransaction(
    connection,
    payer,
    instructions,
    undefined,
    lookupTableAddresses,
  );
  const simulation = await connection.simulateTransaction(tx, {
    sigVerify: false,
    commitment: 'confirmed',
  });
  const returnPrefix = `Program return: ${programId.toBase58()} `;
  const returnLog = simulation.value.logs?.find((log) =>
    log.startsWith(returnPrefix),
  );

  assert(
    returnLog &&
      simulation.value.returnData?.programId === programId.toBase58(),
    `Simulate Fail: ${JSON.stringify(simulation.value)}`,
  );

  return serializer.deserialize(
    Buffer.from(returnLog.slice(returnPrefix.length), 'base64'),
    0,
  )[0];
}

export function deriveUsdt0MeshPdas(programId: PublicKey, dstEid: number) {
  const [oftStore] = PublicKey.findProgramAddressSync([OFT_SEED], programId);
  const [credits] = PublicKey.findProgramAddressSync([CREDITS_SEED], programId);
  const [peer] = PublicKey.findProgramAddressSync(
    [PEER_SEED, encodeDstEid(dstEid)],
    programId,
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [EVENT_AUTHORITY_SEED],
    programId,
  );
  return { oftStore, credits, peer, eventAuthority };
}

export function decodeUsdt0OftStoreAccount(
  rawAccountData: Buffer | Uint8Array,
): Usdt0OftStoreAccount {
  const data = Buffer.from(rawAccountData);
  assert(
    data.length >= 243,
    `OFTStore account too small: ${data.length} bytes`,
  );
  assertAccountDiscriminator(data, OFT_STORE_ACCOUNT_DISCRIMINATOR, 'OFTStore');

  let offset = 8;
  const tokenMint = readPublicKey(data, offset);
  offset += 32;
  const tokenEscrow = readPublicKey(data, offset);
  offset += 32;
  const endpointProgram = readPublicKey(data, offset);
  offset += 32;
  const bump = data.readUInt8(offset);
  offset += 1;
  const feeBalance = data.readBigUInt64LE(offset);
  offset += 8;
  const superAdmin = readPublicKey(data, offset);
  offset += 32;
  const planner = readPublicKey(data, offset);
  offset += 32;
  const lpAdmin = readPublicKey(data, offset);
  offset += 32;
  const burnAndNilifyAdmin = readPublicKey(data, offset);
  offset += 32;
  const feeBps = data.readUInt16LE(offset);
  offset += 2;

  const hasLookupTable = data.readUInt8(offset);
  offset += 1;
  const lookupTable =
    hasLookupTable === 1 ? readPublicKey(data, offset) : undefined;

  return {
    tokenMint,
    tokenEscrow,
    endpointProgram,
    bump,
    feeBalance,
    superAdmin,
    planner,
    lpAdmin,
    burnAndNilifyAdmin,
    feeBps,
    lookupTable,
  };
}

export function decodeUsdt0PeerAddress(
  rawAccountData: Buffer | Uint8Array,
): Uint8Array {
  const data = Buffer.from(rawAccountData);
  assert(
    data.length >= 40,
    `PeerConfig account too small: ${data.length} bytes`,
  );
  assertAccountDiscriminator(
    data,
    PEER_CONFIG_ACCOUNT_DISCRIMINATOR,
    'PeerConfig',
  );
  return Uint8Array.from(data.subarray(8, 40));
}

export async function resolveUsdt0MeshAccounts(
  connection: Connection,
  config: {
    programId: string;
    store: string;
    tokenMint: string;
    dstEid: number;
  },
): Promise<ResolvedUsdt0MeshAccounts> {
  const programId = new PublicKey(config.programId);
  const expectedStore = new PublicKey(config.store);
  const expectedTokenMint = new PublicKey(config.tokenMint);
  const { oftStore, credits, peer, eventAuthority } = deriveUsdt0MeshPdas(
    programId,
    config.dstEid,
  );

  assert(
    oftStore.equals(expectedStore),
    `Configured OFT Store ${expectedStore.toBase58()} does not match derived PDA ${oftStore.toBase58()}`,
  );

  const [storeInfo, creditsInfo, peerInfo] =
    await connection.getMultipleAccountsInfo(
      [oftStore, credits, peer],
      'confirmed',
    );

  assert(storeInfo, `Missing OFT Store account ${oftStore.toBase58()}`);
  assert(
    storeInfo.owner.equals(programId),
    `OFT Store owner mismatch for ${oftStore.toBase58()}`,
  );
  const decodedStore = decodeUsdt0OftStoreAccount(storeInfo.data);
  assert(
    decodedStore.tokenMint.equals(expectedTokenMint),
    `Configured token mint ${expectedTokenMint.toBase58()} does not match store mint ${decodedStore.tokenMint.toBase58()}`,
  );

  assert(creditsInfo, `Missing Credits account ${credits.toBase58()}`);
  assert(
    creditsInfo.owner.equals(programId),
    `Credits owner mismatch for ${credits.toBase58()}`,
  );
  assertAccountDiscriminator(
    creditsInfo.data,
    CREDITS_ACCOUNT_DISCRIMINATOR,
    'Credits',
  );

  assert(peerInfo, `Missing PeerConfig account ${peer.toBase58()}`);
  assert(
    peerInfo.owner.equals(programId),
    `Peer owner mismatch for ${peer.toBase58()}`,
  );
  const peerAddress = decodeUsdt0PeerAddress(peerInfo.data);

  return {
    programId,
    oftStore,
    credits,
    peer,
    eventAuthority,
    tokenMint: decodedStore.tokenMint,
    tokenEscrow: decodedStore.tokenEscrow,
    endpointProgram: decodedStore.endpointProgram,
    peerAddress,
    lookupTable: decodedStore.lookupTable,
  };
}

export function createUsdt0QuoteOftInstruction(
  programId: PublicKey,
  accounts: QuoteInstructionAccounts,
  params: Usdt0QuoteParams,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: accounts.oftStore, isSigner: false, isWritable: false },
      { pubkey: accounts.credits, isSigner: false, isWritable: false },
      { pubkey: accounts.peer, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      QUOTE_OFT_DISCRIMINATOR,
      Buffer.from(
        getQuoteInstructionSerializer().serialize(normalizeQuoteParams(params)),
      ),
    ]),
  });
}

export function createUsdt0QuoteSendInstruction(
  programId: PublicKey,
  accounts: QuoteInstructionAccounts,
  params: Usdt0QuoteParams,
  remainingAccounts: AccountMeta[] = [],
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: accounts.oftStore, isSigner: false, isWritable: false },
      { pubkey: accounts.credits, isSigner: false, isWritable: false },
      { pubkey: accounts.peer, isSigner: false, isWritable: false },
      ...remainingAccounts,
    ],
    data: Buffer.concat([
      QUOTE_SEND_DISCRIMINATOR,
      Buffer.from(
        getQuoteInstructionSerializer().serialize(normalizeQuoteParams(params)),
      ),
    ]),
  });
}

export function createUsdt0SendInstruction(
  programId: PublicKey,
  accounts: SendInstructionAccounts,
  params: Usdt0SendParams,
  remainingAccounts: AccountMeta[] = [],
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: accounts.signer, isSigner: true, isWritable: false },
      { pubkey: accounts.peer, isSigner: false, isWritable: false },
      { pubkey: accounts.oftStore, isSigner: false, isWritable: true },
      { pubkey: accounts.credits, isSigner: false, isWritable: true },
      { pubkey: accounts.tokenSource, isSigner: false, isWritable: true },
      { pubkey: accounts.tokenEscrow, isSigner: false, isWritable: true },
      { pubkey: accounts.tokenMint, isSigner: false, isWritable: false },
      {
        pubkey: accounts.tokenProgram ?? TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: accounts.eventAuthority, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
      ...remainingAccounts,
    ],
    data: Buffer.concat([
      SEND_DISCRIMINATOR,
      Buffer.from(
        getSendInstructionSerializer().serialize(normalizeSendParams(params)),
      ),
    ]),
  });
}

export async function quoteUsdt0Oft(
  connection: Connection,
  accounts: QuoteInstructionAccounts & {
    programId: PublicKey;
  },
  payer: PublicKey,
  params: Usdt0QuoteParams,
): Promise<Usdt0QuoteOftResult> {
  return simulateProgramReturn(
    connection,
    [createUsdt0QuoteOftInstruction(accounts.programId, accounts, params)],
    accounts.programId,
    payer,
    getQuoteOftResultSerializer(),
  );
}

export async function quoteUsdt0Send(
  connection: Connection,
  rpc: RpcInterface,
  accounts: ResolvedUsdt0MeshAccounts,
  payer: PublicKey,
  params: Usdt0QuoteParams,
): Promise<{ nativeFee: bigint; lzTokenFee: bigint }> {
  const sendHelper = new SendHelper(
    umiPublicKey(accounts.endpointProgram.toBase58()),
  );
  const remainingAccounts = await sendHelper.getQuoteAccounts(rpc, {
    payer: umiPublicKey(payer.toBase58()),
    sender: umiPublicKey(accounts.oftStore.toBase58()),
    dstEid: params.dstEid,
    receiver: accounts.peerAddress,
  });

  return simulateProgramReturn(
    connection,
    [
      ComputeBudgetProgram.setComputeUnitLimit({
        units: COMPUTE_UNIT_LIMIT,
      }),
      createUsdt0QuoteSendInstruction(
        accounts.programId,
        accounts,
        params,
        remainingAccounts.map(toWeb3AccountMeta),
      ),
    ],
    accounts.programId,
    payer,
    getMessagingFeeSerializer(),
    accounts.lookupTable,
  );
}

export async function sendUsdt0Transfer(
  connection: Connection,
  rpc: RpcInterface,
  accounts: ResolvedUsdt0MeshAccounts,
  signer: Keypair,
  tokenSource: PublicKey,
  params: Usdt0SendParams,
  tokenProgram?: PublicKey,
): Promise<string> {
  const sendHelper = new SendHelper(
    umiPublicKey(accounts.endpointProgram.toBase58()),
  );
  const remainingAccounts = await sendHelper.getSendAccounts(rpc, {
    payer: umiPublicKey(signer.publicKey.toBase58()),
    sender: umiPublicKey(accounts.oftStore.toBase58()),
    dstEid: params.dstEid,
    receiver: accounts.peerAddress,
  });

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const tx = await buildVersionedTransaction(
    connection,
    signer.publicKey,
    [
      ComputeBudgetProgram.setComputeUnitLimit({
        units: COMPUTE_UNIT_LIMIT,
      }),
      createUsdt0SendInstruction(
        accounts.programId,
        {
          signer: signer.publicKey,
          peer: accounts.peer,
          oftStore: accounts.oftStore,
          credits: accounts.credits,
          eventAuthority: accounts.eventAuthority,
          tokenSource,
          tokenEscrow: accounts.tokenEscrow,
          tokenMint: accounts.tokenMint,
          tokenProgram,
        },
        params,
        remainingAccounts.map(toWeb3AccountMeta),
      ),
    ],
    latestBlockhash.blockhash,
    accounts.lookupTable,
  );

  tx.sign([signer]);
  const signature = await connection.sendTransaction(tx, {
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    'confirmed',
  );
  return signature;
}
