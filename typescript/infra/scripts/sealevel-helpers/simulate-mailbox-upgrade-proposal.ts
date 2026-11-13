import { createHash } from 'crypto';
import path from 'path';

import {
  AccountRole,
  type Address,
  type Instruction,
  address,
  generateKeyPairSigner,
  getAddressEncoder,
} from '@solana/kit';
import {
  type AccountMeta,
  Connection,
  type ParsedInstruction,
  type ParsedMessageAccount,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  accounts,
  getProposalPda,
  getTransactionPda,
  getVaultPda,
  instructions as squadsInstructions,
  utils as squadsUtils,
} from '@sqds/multisig';
import bs58 from 'bs58';
import { z } from 'zod';

import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import {
  HYPERLANE_SVM_PROGRAM_BYTES,
  HYPERLANE_SVM_PROGRAM_VERSION,
  SealevelImpersonatingSigner,
  SealevelMailboxReader,
  convertLegacySolanaTransaction,
  createRpc,
  decodeMailboxOutboxAccount,
  deriveMailboxDispatchedMessagePda,
  deriveMailboxInboxPda,
  deriveMailboxOutboxPda,
  fetchMailboxInboxAccount,
  getProgramUpgradeAuthority,
} from '@hyperlane-xyz/sealevel-sdk';
import { createSvmForkManager } from '@hyperlane-xyz/sealevel-sdk/fork';
import {
  ProtocolType,
  assert,
  eqAddressSol,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { getRegistryForEnvironment } from '../../src/config/chain.js';
import { getSquadsKeys } from '../../src/config/squads.js';
import { GovernanceType } from '../../src/governanceTypes.js';
import {
  LOADER_V3,
  MAX_COMPUTE_UNITS,
  assertMailboxUpgradeInstruction,
} from '../../src/utils/mailbox-upgrade.js';
import {
  parseReceiptFile,
  planReceiptProposals,
  resolveWireAddressLookupTables,
} from '../../src/utils/warp-propose-squads.js';
import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const logger = rootLogger.child({
  module: 'simulate-mailbox-upgrade-proposal',
});

const ADDRESS_ENCODER = getAddressEncoder();
const PROGRAM_DATA_HEADER_SIZE = 45;
const BUFFER_HEADER_SIZE = 37;
const INBOX_PROCESS_DISCRIMINATOR = 1;
const INBOX_PROCESS_SEARCH_BATCH_SIZE = 20;
const INBOX_PROCESS_SEARCH_LIMIT = 100;
const MAX_SOURCE_TRANSACTION_VERSION = 1;
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const SPL_NOOP_PROGRAM = address('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
const VOTER_PERMISSION = 2;
const EXECUTOR_PERMISSION = 4;

const RpcAccountSchema = z.object({
  result: z.object({
    value: z
      .object({
        data: z.tuple([z.string(), z.string()]),
        owner: z.string(),
      })
      .nullable(),
  }),
});

type RpcAccount = {
  data: Buffer;
  owner: string;
};

type InboxProcessReplay = {
  addressLookupTables: Address[];
  instruction: Instruction;
  payer: Address;
  processedMessage: Address;
  sourceSignature: string;
  version: 0 | 1;
};

async function fetchRpcAccount(
  rpcUrl: string,
  account: string,
): Promise<RpcAccount | null> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [account, { encoding: 'base64', commitment: 'confirmed' }],
    }),
  });
  assert(response.ok, `RPC getAccountInfo failed with HTTP ${response.status}`);
  const parsed = RpcAccountSchema.parse(await response.json());
  if (!parsed.result.value) return null;
  return {
    data: Buffer.from(parsed.result.value.data[0], 'base64'),
    owner: parsed.result.value.owner,
  };
}

function isPartiallyDecodedInstruction(
  instruction: ParsedInstruction | PartiallyDecodedInstruction,
): instruction is PartiallyDecodedInstruction {
  return 'accounts' in instruction && 'data' in instruction;
}

function accountRole(account: ParsedMessageAccount): AccountRole {
  if (account.signer) {
    return account.writable
      ? AccountRole.WRITABLE_SIGNER
      : AccountRole.READONLY_SIGNER;
  }
  return account.writable ? AccountRole.WRITABLE : AccountRole.READONLY;
}

async function parseInboxProcessReplay({
  mailbox,
  signature,
  source,
}: {
  mailbox: Address;
  signature: string;
  source: ParsedTransactionWithMeta;
}): Promise<InboxProcessReplay | null> {
  if (!source.meta || source.meta.err !== null) return null;

  const mailboxProgram = new PublicKey(mailbox);
  const processInstructions = source.transaction.message.instructions
    .filter(isPartiallyDecodedInstruction)
    .filter((instruction) => {
      if (!instruction.programId.equals(mailboxProgram)) return false;
      return bs58.decode(instruction.data)[0] === INBOX_PROCESS_DISCRIMINATOR;
    });
  if (processInstructions.length === 0) return null;
  assert(
    processInstructions.length === 1,
    `Expected one InboxProcess instruction in ${signature}, got ${processInstructions.length}`,
  );
  const processInstruction = processInstructions[0];
  assert(processInstruction, 'Missing InboxProcess instruction');

  const messageAccounts = new Map(
    source.transaction.message.accountKeys.map((account) => [
      account.pubkey.toBase58(),
      account,
    ]),
  );
  const accounts = processInstruction.accounts.map((pubkey) => {
    const account = messageAccounts.get(pubkey.toBase58());
    assert(account, `Missing message account metadata for ${pubkey}`);
    return {
      address: address(pubkey.toBase58()),
      role: accountRole(account),
    };
  });
  const payer = accounts[0];
  const inbox = accounts[2];
  const processedMessage = accounts[4];
  const { address: expectedInbox } = await deriveMailboxInboxPda(mailbox);
  assert(
    payer?.role === AccountRole.WRITABLE_SIGNER,
    'InboxProcess payer is not a writable signer',
  );
  assert(
    inbox && eqAddressSol(inbox.address, expectedInbox),
    `InboxProcess targets inbox ${inbox?.address}, expected ${expectedInbox}`,
  );
  assert(
    processedMessage?.role === AccountRole.WRITABLE,
    'InboxProcess processed-message account is not writable',
  );
  assert(
    accounts.filter(
      (account) =>
        account.role === AccountRole.READONLY_SIGNER ||
        account.role === AccountRole.WRITABLE_SIGNER,
    ).length === 1,
    'InboxProcess replay must require only its payer to sign',
  );
  assert(
    source.version === undefined ||
      source.version === 'legacy' ||
      source.version === 0 ||
      source.version === 1,
    `Unsupported inbound source transaction version ${source.version}`,
  );
  const version = source.version === 1 ? 1 : 0;
  const addressLookupTables =
    source.transaction.message.addressTableLookups?.map((lookup) =>
      address(lookup.accountKey.toBase58()),
    ) ?? [];
  assert(
    version === 0 || addressLookupTables.length === 0,
    'Version-1 InboxProcess replay cannot use address lookup tables',
  );

  return {
    addressLookupTables,
    instruction: {
      programAddress: mailbox,
      accounts,
      data: bs58.decode(processInstruction.data),
    },
    payer: payer.address,
    processedMessage: processedMessage.address,
    sourceSignature: signature,
    version,
  };
}

async function findRecentInboxProcessReplay({
  connection,
  mailbox,
  maxSupportedTransactionVersion,
}: {
  connection: Connection;
  mailbox: Address;
  maxSupportedTransactionVersion: number;
}): Promise<InboxProcessReplay> {
  const signatures = await connection.getSignaturesForAddress(
    new PublicKey(mailbox),
    { limit: INBOX_PROCESS_SEARCH_LIMIT },
    'confirmed',
  );

  for (
    let offset = 0;
    offset < signatures.length;
    offset += INBOX_PROCESS_SEARCH_BATCH_SIZE
  ) {
    const successful = signatures
      .slice(offset, offset + INBOX_PROCESS_SEARCH_BATCH_SIZE)
      .filter((entry) => entry.err === null);
    const transactions = await connection.getParsedTransactions(
      successful.map((entry) => entry.signature),
      {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: MAX_SOURCE_TRANSACTION_VERSION,
      },
    );

    for (const [index, source] of transactions.entries()) {
      const signature = successful[index]?.signature;
      if (!source || !signature) continue;
      if (
        source.version === 1 &&
        maxSupportedTransactionVersion < MAX_SOURCE_TRANSACTION_VERSION
      ) {
        continue;
      }
      const replay = await parseInboxProcessReplay({
        mailbox,
        signature,
        source,
      });
      if (replay) return replay;
    }
  }

  throw new Error(
    `No successful InboxProcess transaction found in the latest ${signatures.length} mailbox transactions`,
  );
}

async function clearProcessedMessageAccount(
  rpcUrl: string,
  processedMessage: Address,
): Promise<void> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'surfnet_setAccount',
      params: [
        processedMessage,
        {
          data: '',
          executable: false,
          lamports: 0,
          owner: SYSTEM_PROGRAM,
          rentEpoch: 0,
        },
      ],
    }),
  });
  assert(
    response.ok,
    `Surfpool setAccount failed with HTTP ${response.status}`,
  );
  const result: unknown = await response.json();
  const parsed = z
    .union([
      z.object({ result: z.unknown() }),
      z.object({ error: z.object({ message: z.string() }) }),
    ])
    .parse(result);
  assert(
    !('error' in parsed),
    `Surfpool setAccount failed: ${'error' in parsed ? parsed.error.message : 'unknown error'}`,
  );

  const cleared = await fetchRpcAccount(rpcUrl, processedMessage);
  assert(
    !cleared || (cleared.owner === SYSTEM_PROGRAM && cleared.data.length === 0),
    `Processed-message account ${processedMessage} was not cleared`,
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function encodeU32(value: number): Uint8Array {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function concatBytes(parts: readonly ArrayLike<number>[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)));
}

async function buildSmokeDispatchInstruction({
  mailbox,
  sender,
  payer,
}: {
  mailbox: Address;
  sender: Address;
  payer: Address;
}): Promise<{
  instruction: Instruction;
  uniqueMessageAccount: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  dispatchedMessage: Address;
}> {
  const uniqueMessageAccount = await generateKeyPairSigner();
  const { address: outbox } = await deriveMailboxOutboxPda(mailbox);
  const { address: dispatchedMessage } =
    await deriveMailboxDispatchedMessagePda(
      mailbox,
      uniqueMessageAccount.address,
    );
  const body = new TextEncoder().encode('mailbox-upgrade-fork-smoke-test');
  const data = concatBytes([
    Uint8Array.of(4),
    ADDRESS_ENCODER.encode(sender),
    encodeU32(1),
    ADDRESS_ENCODER.encode(sender),
    encodeU32(body.length),
    body,
  ]);

  return {
    instruction: {
      programAddress: mailbox,
      accounts: [
        { address: outbox, role: AccountRole.WRITABLE },
        { address: sender, role: AccountRole.READONLY_SIGNER },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        { address: SPL_NOOP_PROGRAM, role: AccountRole.READONLY },
        { address: payer, role: AccountRole.WRITABLE_SIGNER },
        {
          address: uniqueMessageAccount.address,
          role: AccountRole.WRITABLE_SIGNER,
        },
        { address: dispatchedMessage, role: AccountRole.WRITABLE },
      ],
      data,
    },
    uniqueMessageAccount,
    dispatchedMessage,
  };
}

function accountMetaAt(
  accountMetas: AccountMeta[],
  index: number,
  instructionIndex: number,
): AccountMeta {
  const meta = accountMetas[index];
  assert(
    meta,
    `Squads account index out of range: instruction=${instructionIndex} index=${index}`,
  );
  return meta;
}

function rebuildSquadsInstructions(
  message: accounts.VaultTransaction['message'],
  accountMetas: AccountMeta[],
): TransactionInstruction[] {
  const lookupOffset = message.addressTableLookups.length;
  return message.instructions.map((instruction, instructionIndex) => {
    const program = accountMetaAt(
      accountMetas,
      lookupOffset + instruction.programIdIndex,
      instructionIndex,
    );
    const keys = Array.from(instruction.accountIndexes).map((accountIndex) =>
      accountMetaAt(
        accountMetas,
        lookupOffset + accountIndex,
        instructionIndex,
      ),
    );
    return new TransactionInstruction({
      programId: program.pubkey,
      keys,
      data: Buffer.from(instruction.data),
    });
  });
}

function assertInstructionEqual(
  actual: TransactionInstruction,
  expected: TransactionInstruction,
  index: number,
  vault: PublicKey,
): void {
  assert(
    actual.programId.equals(expected.programId),
    `Proposal instruction ${index} program mismatch`,
  );
  assert(
    actual.data.equals(expected.data),
    `Proposal instruction ${index} data mismatch`,
  );
  assert(
    actual.keys.length === expected.keys.length,
    `Proposal instruction ${index} account count mismatch`,
  );
  actual.keys.forEach((account, accountIndex) => {
    const expectedAccount = expected.keys[accountIndex];
    assert(
      expectedAccount,
      `Expected proposal instruction ${index} account ${accountIndex}`,
    );
    assert(
      account.pubkey.equals(expectedAccount.pubkey),
      `Proposal instruction ${index} account ${accountIndex} address mismatch: ${account.pubkey} != ${expectedAccount.pubkey}`,
    );
    // `accountsForTransactionExecute` returns the vault's outer-CPI meta. The
    // stored inner message makes the vault its payer, so it is effectively a
    // writable signer even though Squads invokes it with PDA seeds.
    const isVault = account.pubkey.equals(vault);
    const effectiveSigner = account.isSigner || isVault;
    const effectiveWritable = account.isWritable || isVault;
    assert(
      effectiveSigner === expectedAccount.isSigner,
      `Proposal instruction ${index} account ${accountIndex} signer role mismatch`,
    );
    assert(
      effectiveWritable === expectedAccount.isWritable ||
        (isVault && !expectedAccount.isWritable),
      `Proposal instruction ${index} account ${accountIndex} writable role mismatch`,
    );
  });
}

async function assertProposalMatchesReceipt({
  connection,
  proposalIndex,
  receiptInstructions,
  multisigPda,
  programId,
  expectedVault,
}: {
  connection: Connection;
  proposalIndex: bigint;
  receiptInstructions: TransactionInstruction[];
  multisigPda: PublicKey;
  programId: PublicKey;
  expectedVault: PublicKey;
}): Promise<{
  proposalPda: PublicKey;
  transactionPda: PublicKey;
}> {
  const [proposalPda] = getProposalPda({
    multisigPda,
    transactionIndex: proposalIndex,
    programId,
  });
  const [transactionPda] = getTransactionPda({
    multisigPda,
    index: proposalIndex,
    programId,
  });
  const proposal = await accounts.Proposal.fromAccountAddress(
    connection,
    proposalPda,
  );
  assert(
    proposal.status.__kind === 'Active' ||
      proposal.status.__kind === 'Approved',
    `Proposal ${proposalIndex} has status ${proposal.status.__kind}`,
  );
  const transaction = await accounts.VaultTransaction.fromAccountAddress(
    connection,
    transactionPda,
  );
  const [vault] = getVaultPda({
    multisigPda,
    index: transaction.vaultIndex,
    programId,
  });
  assert(vault.equals(expectedVault), `Unexpected proposal vault ${vault}`);
  const { accountMetas } = await squadsUtils.accountsForTransactionExecute({
    connection,
    message: transaction.message,
    ephemeralSignerBumps: [...transaction.ephemeralSignerBumps],
    vaultPda: vault,
    transactionPda,
    programId,
  });
  const storedInstructions = rebuildSquadsInstructions(
    transaction.message,
    accountMetas,
  );
  assert(
    storedInstructions.length === receiptInstructions.length,
    `Proposal has ${storedInstructions.length} instruction(s), receipt has ${receiptInstructions.length}`,
  );
  storedInstructions.forEach((instruction, index) => {
    const expected = receiptInstructions[index];
    assert(expected, `Missing receipt instruction ${index}`);
    assertInstructionEqual(instruction, expected, index, expectedVault);
  });
  return { proposalPda, transactionPda };
}

async function approveProposalOnFork({
  connection,
  metadata,
  proposalIndex,
  multisigPda,
  programId,
}: {
  connection: Connection;
  metadata: ChainMetadataForAltVM;
  proposalIndex: bigint;
  multisigPda: PublicKey;
  programId: PublicKey;
}): Promise<PublicKey> {
  const [proposalPda] = getProposalPda({
    multisigPda,
    transactionIndex: proposalIndex,
    programId,
  });
  const multisig = await accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda,
  );
  let proposal = await accounts.Proposal.fromAccountAddress(
    connection,
    proposalPda,
  );
  const approved = new Set(
    proposal.approved.map((member) => member.toBase58()),
  );
  const threshold = Number(multisig.threshold);
  const voters = multisig.members.filter(
    (member) => (Number(member.permissions.mask) & VOTER_PERMISSION) !== 0,
  );

  for (const voter of voters) {
    if (approved.size >= threshold) break;
    const voterAddress = voter.key.toBase58();
    if (approved.has(voterAddress)) continue;
    const instruction = squadsInstructions.proposalApprove({
      multisigPda,
      transactionIndex: proposalIndex,
      member: voter.key,
      programId,
    });
    const transaction = await convertLegacySolanaTransaction({
      instructions: [instruction],
    });
    const signer = await SealevelImpersonatingSigner.create(
      metadata,
      voterAddress,
    );
    await signer.send(transaction);
    approved.add(voterAddress);
  }

  assert(
    approved.size >= threshold,
    `Only ${approved.size} voter approvals available; threshold is ${threshold}`,
  );
  proposal = await accounts.Proposal.fromAccountAddress(
    connection,
    proposalPda,
  );
  assert(
    proposal.status.__kind === 'Approved',
    `Fork proposal did not become Approved: ${proposal.status.__kind}`,
  );
  const executor = multisig.members.find(
    (member) => (Number(member.permissions.mask) & EXECUTOR_PERMISSION) !== 0,
  );
  assert(executor, 'Squads multisig has no executor');
  return executor.key;
}

async function executeProposalOnFork({
  connection,
  metadata,
  proposalIndex,
  multisigPda,
  programId,
  executor,
}: {
  connection: Connection;
  metadata: ChainMetadataForAltVM;
  proposalIndex: bigint;
  multisigPda: PublicKey;
  programId: PublicKey;
  executor: PublicKey;
}): Promise<{ signature: string; computeUnitsConsumed: number }> {
  const { instruction, lookupTableAccounts } =
    await squadsInstructions.vaultTransactionExecute({
      connection,
      multisigPda,
      transactionIndex: proposalIndex,
      member: executor,
      programId,
    });
  assert(
    lookupTableAccounts.length === 0,
    'Mailbox upgrade proposal unexpectedly requires address lookup tables',
  );
  const transaction = await convertLegacySolanaTransaction({
    instructions: [instruction],
  });
  const signer = await SealevelImpersonatingSigner.create(
    metadata,
    executor.toBase58(),
  );
  const receipt = await signer.send({
    ...transaction,
    computeUnits: MAX_COMPUTE_UNITS,
    waitForSlotAdvance: true,
  });
  const executedTransaction = await connection.getTransaction(
    receipt.signature,
    {
      commitment: 'confirmed',
      maxSupportedTransactionVersion:
        metadata.maxSupportedTransactionVersion ?? 0,
    },
  );
  const computeUnitsConsumed = executedTransaction?.meta?.computeUnitsConsumed;
  assert(
    computeUnitsConsumed !== undefined,
    `Compute units consumed unavailable for ${receipt.signature}`,
  );
  return { signature: receipt.signature, computeUnitsConsumed };
}

async function main(): Promise<void> {
  const argv = await getArgs()
    .option('chain', {
      type: 'string',
      default: 'solanamainnet',
    })
    .option('mailbox', {
      type: 'string',
      demandOption: true,
    })
    .option('upgradeAuthority', {
      type: 'string',
      demandOption: true,
    })
    .option('proposalIndex', {
      type: 'number',
      demandOption: true,
    })
    .option('receipt', {
      type: 'string',
      demandOption: true,
    })
    .option('expectedVersion', {
      type: 'string',
      default: HYPERLANE_SVM_PROGRAM_VERSION,
    })
    .option('rpcPort', {
      type: 'number',
      default: 8899,
    })
    .strict().argv;

  const { chain, environment, expectedVersion, rpcPort } = argv;
  assert(
    Number.isSafeInteger(argv.proposalIndex) && argv.proposalIndex > 0,
    'proposalIndex must be a positive safe integer',
  );
  assert(
    Number.isSafeInteger(rpcPort) && rpcPort > 1024 && rpcPort < 65534,
    'rpcPort must be an integer between 1025 and 65533',
  );
  const proposalIndex = BigInt(argv.proposalIndex);
  const mailbox = address(argv.mailbox);
  const expectedUpgradeAuthority = address(argv.upgradeAuthority);
  const receiptPath = path.resolve(argv.receipt);

  const registry = await getRegistryForEnvironment(environment, [chain]);
  const metadata = await registry.getChainMetadata(chain);
  assert(metadata, `Chain not found: ${chain}`);
  assert(
    metadata.protocol === ProtocolType.Sealevel,
    `${chain} is not a Sealevel chain`,
  );
  const upstreamRpcUrl = metadata.rpcUrls[0]?.http;
  assert(upstreamRpcUrl, `No RPC URL configured for ${chain}`);

  const mpp =
    await getEnvironmentConfig(environment).getMultiProtocolProvider();
  const parsed = parseReceiptFile(receiptPath, mpp);
  if ('error' in parsed) {
    throw new Error(`Invalid receipt: ${parsed.error}`);
  }
  assert(
    parsed.chain === chain,
    `Receipt chain is ${parsed.chain}, expected ${chain}`,
  );
  assert(
    parsed.txs.length === 1,
    `Expected one receipt tx, got ${parsed.txs.length}`,
  );
  const receipt = parsed.txs[0];
  assert(receipt, 'Missing receipt transaction');
  assert(
    receipt.instructions.length === 1,
    `Expected exactly one mailbox upgrade instruction, got ${receipt.instructions.length}`,
  );
  assert(
    receipt.computeUnits === MAX_COMPUTE_UNITS,
    `Expected ${MAX_COMPUTE_UNITS} compute units`,
  );

  const upstreamConnection = mpp.getSolanaWeb3Provider(chain);
  const inboundReplay = await findRecentInboxProcessReplay({
    connection: upstreamConnection,
    mailbox,
    maxSupportedTransactionVersion:
      metadata.maxSupportedTransactionVersion ?? 0,
  });
  const altAccounts = await resolveWireAddressLookupTables(
    receipt.transaction_base58,
    upstreamConnection,
  );
  const plans = planReceiptProposals(parsed.txs, [altAccounts]);
  const plan = plans[0];
  assert(plan && plans.length === 1, 'Expected one Squads proposal plan');
  const squadsKeys = getSquadsKeys(chain, GovernanceType.Regular);
  assert(
    eqAddressSol(squadsKeys.vault.toBase58(), expectedUpgradeAuthority),
    `Regular Squads vault is ${squadsKeys.vault}, expected ${expectedUpgradeAuthority}`,
  );
  const proposalAddresses = await assertProposalMatchesReceipt({
    connection: upstreamConnection,
    proposalIndex,
    receiptInstructions: plan.instructions,
    multisigPda: squadsKeys.multisigPda,
    programId: squadsKeys.programId,
    expectedVault: squadsKeys.vault,
  });

  const upgradeInstruction = receipt.instructions[0];
  assert(upgradeInstruction, 'Receipt is missing its upgrade instruction');
  const bufferAddress = upgradeInstruction.accounts?.[2]?.address;
  const spillAddress = upgradeInstruction.accounts?.[3]?.address;
  assert(
    bufferAddress && spillAddress,
    'Upgrade receipt is missing buffer/spill accounts',
  );
  assertMailboxUpgradeInstruction({
    instruction: upgradeInstruction,
    mailbox,
    upgradeAuthority: expectedUpgradeAuthority,
    spillAddress,
  });
  logger.info(
    { buffer: bufferAddress, spill: spillAddress },
    'Validated mailbox upgrade instruction accounts',
  );
  const upstreamBuffer = await fetchRpcAccount(upstreamRpcUrl, bufferAddress);
  assert(upstreamBuffer, `Upgrade buffer ${bufferAddress} is missing`);
  assert(
    upstreamBuffer.owner === LOADER_V3 &&
      upstreamBuffer.data.readUInt32LE(0) === 1,
    `Invalid upgrade buffer ${bufferAddress}`,
  );
  const bufferAuthority = new PublicKey(
    upstreamBuffer.data.subarray(5, BUFFER_HEADER_SIZE),
  ).toBase58();
  assert(
    eqAddressSol(bufferAuthority, expectedUpgradeAuthority),
    `Buffer authority is ${bufferAuthority}`,
  );
  const expectedBytes = HYPERLANE_SVM_PROGRAM_BYTES.mailbox;
  const expectedHash = sha256(expectedBytes);
  assert(
    upstreamBuffer.data.length === BUFFER_HEADER_SIZE + expectedBytes.length &&
      sha256(upstreamBuffer.data.subarray(BUFFER_HEADER_SIZE)) === expectedHash,
    'Upgrade buffer bytes do not match the bundled mailbox program',
  );

  const forkManager = createSvmForkManager({
    chainName: chain,
    upstreamRpcUrl,
    rpcPort,
    wsPort: rpcPort + 1,
  });

  try {
    await forkManager.start();
    const forkRpcUrl = forkManager.getForkedChainMetadata().rpcUrls[0]?.http;
    assert(forkRpcUrl, 'Fork metadata missing RPC URL');
    const forkMetadata = {
      ...metadata,
      rpcUrls: [{ http: forkRpcUrl }],
    } satisfies ChainMetadataForAltVM;
    const forkRpc = createRpc(forkRpcUrl);
    const forkConnection = new Connection(forkRpcUrl, 'confirmed');
    const reader = new SealevelMailboxReader(forkRpc);
    const before = await reader.read(mailbox);
    assert(
      before.config.contractVersion === undefined,
      `Expected legacy mailbox before fork execution, got ${before.config.contractVersion}`,
    );
    const { address: inbox } = await deriveMailboxInboxPda(mailbox);
    const { address: outbox } = await deriveMailboxOutboxPda(mailbox);
    const inboxBefore = await fetchRpcAccount(forkRpcUrl, inbox);
    const outboxBefore = await fetchRpcAccount(forkRpcUrl, outbox);
    assert(
      inboxBefore && outboxBefore,
      'Mailbox state accounts missing on fork',
    );
    const inboxHashBefore = sha256(inboxBefore.data);
    const outboxHashBefore = sha256(outboxBefore.data);
    const outboxDataBefore = decodeMailboxOutboxAccount(outboxBefore.data);
    assert(outboxDataBefore, 'Mailbox outbox data missing before upgrade');

    const executor = await approveProposalOnFork({
      connection: forkConnection,
      metadata: forkMetadata,
      proposalIndex,
      multisigPda: squadsKeys.multisigPda,
      programId: squadsKeys.programId,
    });
    const executionReceipt = await executeProposalOnFork({
      connection: forkConnection,
      metadata: forkMetadata,
      proposalIndex,
      multisigPda: squadsKeys.multisigPda,
      programId: squadsKeys.programId,
      executor,
    });

    const after = await reader.read(mailbox);
    assert(
      after.config.contractVersion === expectedVersion,
      `Fork mailbox version is ${after.config.contractVersion}, expected ${expectedVersion}`,
    );
    assert(
      after.deployed.domainId === before.deployed.domainId &&
        after.config.owner === before.config.owner &&
        after.config.defaultIsm.deployed.address ===
          before.config.defaultIsm.deployed.address,
      'Mailbox config changed during program upgrade',
    );
    const authorityAfter = await getProgramUpgradeAuthority(forkRpc, mailbox);
    assert(
      authorityAfter && eqAddressSol(authorityAfter, expectedUpgradeAuthority),
      `Fork upgrade authority changed to ${authorityAfter}`,
    );
    const inboxAfter = await fetchRpcAccount(forkRpcUrl, inbox);
    const outboxAfterUpgrade = await fetchRpcAccount(forkRpcUrl, outbox);
    assert(
      inboxAfter && outboxAfterUpgrade,
      'Mailbox state missing after upgrade',
    );
    assert(
      sha256(inboxAfter.data) === inboxHashBefore &&
        sha256(outboxAfterUpgrade.data) === outboxHashBefore,
      'Mailbox PDA data changed during program upgrade',
    );

    const programDataAddress = PublicKey.findProgramAddressSync(
      [new PublicKey(mailbox).toBuffer()],
      new PublicKey(LOADER_V3),
    )[0].toBase58();
    const programData = await fetchRpcAccount(forkRpcUrl, programDataAddress);
    assert(programData, 'Mailbox ProgramData missing after fork upgrade');
    assert(
      Buffer.from(
        programData.data.subarray(
          PROGRAM_DATA_HEADER_SIZE,
          PROGRAM_DATA_HEADER_SIZE + expectedBytes.length,
        ),
      ).equals(Buffer.from(expectedBytes)),
      'Fork mailbox ProgramData does not match bundled bytes',
    );
    assert(
      (await fetchRpcAccount(forkRpcUrl, bufferAddress)) === null,
      'Upgrade buffer was not closed after execution',
    );

    const sourceProcessedMessage = await fetchRpcAccount(
      forkRpcUrl,
      inboundReplay.processedMessage,
    );
    assert(
      sourceProcessedMessage?.owner === mailbox,
      `Source processed-message account ${inboundReplay.processedMessage} is missing or not owned by the mailbox`,
    );
    const inboxBeforeReplay = await fetchMailboxInboxAccount(forkRpc, mailbox);
    assert(inboxBeforeReplay, 'Mailbox inbox missing before inbound replay');
    await clearProcessedMessageAccount(
      forkRpcUrl,
      inboundReplay.processedMessage,
    );
    const inboundSigner = await SealevelImpersonatingSigner.create(
      forkMetadata,
      inboundReplay.payer,
    );
    const inboundReceipt = await inboundSigner.send({
      version: inboundReplay.version,
      instructions: [inboundReplay.instruction],
      computeUnits: MAX_COMPUTE_UNITS,
      addressLookupTables: inboundReplay.addressLookupTables,
      waitForSlotAdvance: true,
    });
    const replayedProcessedMessage = await fetchRpcAccount(
      forkRpcUrl,
      inboundReplay.processedMessage,
    );
    assert(
      replayedProcessedMessage?.owner === mailbox &&
        replayedProcessedMessage.data.length > 0,
      `Inbound replay did not recreate processed-message account ${inboundReplay.processedMessage}`,
    );
    const inboxAfterReplay = await fetchMailboxInboxAccount(forkRpc, mailbox);
    assert(inboxAfterReplay, 'Mailbox inbox missing after inbound replay');
    assert(
      inboxAfterReplay.processedCount === inboxBeforeReplay.processedCount + 1n,
      `Inbound replay changed processed count from ${inboxBeforeReplay.processedCount} to ${inboxAfterReplay.processedCount}`,
    );

    const smokeSender = (await generateKeyPairSigner()).address;
    const smokeSigner = await SealevelImpersonatingSigner.create(
      forkMetadata,
      smokeSender,
    );
    const smoke = await buildSmokeDispatchInstruction({
      mailbox,
      sender: address(smokeSender),
      payer: address(smokeSigner.getSignerAddress()),
    });
    const dispatchReceipt = await smokeSigner.send({
      instructions: [smoke.instruction],
      additionalSigners: [smoke.uniqueMessageAccount],
      waitForSlotAdvance: true,
    });
    const dispatchedMessage = await fetchRpcAccount(
      forkRpcUrl,
      smoke.dispatchedMessage,
    );
    const outboxAfterDispatch = await fetchRpcAccount(forkRpcUrl, outbox);
    assert(
      dispatchedMessage,
      'Smoke-test dispatched-message PDA was not created',
    );
    assert(outboxAfterDispatch, 'Mailbox outbox missing after smoke dispatch');
    const outboxDataAfterDispatch = decodeMailboxOutboxAccount(
      outboxAfterDispatch.data,
    );
    assert(
      outboxDataAfterDispatch,
      'Mailbox outbox data missing after dispatch',
    );
    assert(
      outboxDataAfterDispatch.messageCount ===
        outboxDataBefore.messageCount + 1n,
      `Mailbox outbox count changed from ${outboxDataBefore.messageCount} to ${outboxDataAfterDispatch.messageCount}`,
    );
    const finalRead = await reader.read(mailbox);
    assert(
      finalRead.config.contractVersion === expectedVersion,
      'Mailbox version read failed after smoke dispatch',
    );
    const [localProposalPda] = getProposalPda({
      multisigPda: squadsKeys.multisigPda,
      transactionIndex: proposalIndex,
      programId: squadsKeys.programId,
    });
    const localProposal = await accounts.Proposal.fromAccountAddress(
      forkConnection,
      localProposalPda,
    );
    assert(
      localProposal.status.__kind === 'Executed',
      `Fork proposal status is ${localProposal.status.__kind}`,
    );

    logger.info(
      {
        buffer: bufferAddress,
        dispatchSignature: dispatchReceipt.signature,
        expectedHash,
        executionComputeUnitsConsumed: executionReceipt.computeUnitsConsumed,
        executionSignature: executionReceipt.signature,
        forkRpcUrl,
        inboundReplaySignature: inboundReceipt.signature,
        inboundSourceSignature: inboundReplay.sourceSignature,
        mailbox,
        outboxMessageCountAfter:
          outboxDataAfterDispatch.messageCount.toString(),
        outboxMessageCountBefore: outboxDataBefore.messageCount.toString(),
        proposalIndex: proposalIndex.toString(),
        proposalPda: proposalAddresses.proposalPda.toBase58(),
        spill: spillAddress,
        transactionPda: proposalAddresses.transactionPda.toBase58(),
        version: finalRead.config.contractVersion,
      },
      'Mailbox upgrade proposal passed Surfpool fork simulation',
    );
  } finally {
    forkManager.kill();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'Mailbox upgrade proposal simulation failed',
    );
    process.exit(1);
  });
