import {
  address as parseAddress,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  getShortU16Encoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from '@solana/kit';

import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  CompositeIsmArtifactConfig,
  CompositeIsmNodeArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { assert, deepEquals, rootLogger } from '@hyperlane-xyz/utils';

import {
  decodeCompositeIsmStorageAccount,
  decodeDomainIsmStorageAccount,
  type IsmNode,
} from '../accounts/composite-ism.js';
import { encodeH160, encodeH256 } from '../codecs/shared.js';
import { DEFAULT_COMPUTE_UNITS } from '../constants.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import {
  getInitializeCompositeIsmInstruction,
  getPauseCompositeIsmInstruction,
  getRemoveCompositeIsmDomainInstruction,
  getSetCompositeIsmDomainInstruction,
  getTransferCompositeIsmOwnershipInstruction,
  getUnpauseCompositeIsmInstruction,
  getUpdateCompositeIsmConfigInstruction,
} from '../instructions/composite-ism.js';
import { deriveCompositeIsmStoragePda } from '../pda.js';
import { fetchAccountDataRaw } from '../rpc.js';
import { getComputeBudgetInstructions } from '../tx.js';
import type { SvmSigner } from '../clients/signer.js';
import type {
  AnnotatedSvmTransaction,
  SvmDeployedIsm,
  SvmProgramTarget,
  SvmReceipt,
  SvmRpc,
} from '../types.js';

import { validatorBytesToHex } from './ism-query.js';

const logger = rootLogger.child({ module: 'composite-ism' });

// Solana's serialized transaction size limit
// (https://solana.com/docs/core/transactions#transaction-size). Each domain
// instruction carries a recursive, variable-sized IsmNode — unlike
// fixed-width entries elsewhere in this package, a static per-tx count
// can't safely bound size (a handful of large multisig/aggregation subtrees
// can already exceed the limit), so domain instructions are batched by
// actual serialized size instead.
const SOLANA_MAX_TRANSACTION_SIZE = 1232;
const DUMMY_BLOCKHASH = blockhash('11111111111111111111111111111111');

/**
 * Real serialized wire size (signatures + message) for a candidate
 * transaction, including the ComputeBudget instruction `SvmSigner.send()`
 * always prepends (`buildTransactionMessage` in tx.ts) — measuring only the
 * domain instructions themselves undercounts the actual submitted size.
 */
function estimateTransactionWireSize(
  feePayer: Address,
  instructions: readonly Instruction[],
): number {
  const message = appendTransactionMessageInstructions(
    [...getComputeBudgetInstructions(DEFAULT_COMPUTE_UNITS), ...instructions],
    setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
      setTransactionMessageFeePayer(
        feePayer,
        createTransactionMessage({ version: 0 }),
      ),
    ),
  );
  const compiled = compileTransactionMessage(message);
  const messageBytes = getCompiledTransactionMessageEncoder().encode(compiled);
  const sigCountBytes = getShortU16Encoder().encode(
    compiled.header.numSignerAccounts,
  );
  return (
    sigCountBytes.length +
    compiled.header.numSignerAccounts * 64 +
    messageBytes.length
  );
}

/**
 * Greedily groups items into batches whose instructions fit within Solana's
 * transaction size limit, using the real serialized size (not a fixed
 * per-item count) since domain instructions are variable-sized.
 */
function chunkInstructionsBySize<T>(
  items: readonly T[],
  toInstruction: (item: T) => Instruction,
  feePayer: Address,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    // Checked unconditionally (not just in the "merge" branch below) — an
    // oversized item that starts a fresh chunk (because it doesn't fit
    // alongside the previous batch) would otherwise never hit this check
    // and get pushed as an ordinary single-item chunk, only failing later
    // with an opaque RPC size error instead of this message.
    const soloSize = estimateTransactionWireSize(feePayer, [
      toInstruction(item),
    ]);
    assert(
      soloSize <= SOLANA_MAX_TRANSACTION_SIZE,
      `Composite ISM domain instruction alone (${soloSize} bytes) exceeds Solana's ` +
        `${SOLANA_MAX_TRANSACTION_SIZE}-byte transaction size limit — the nested ` +
        `ISM tree for this domain is too large to submit in a single instruction.`,
    );

    const candidate = [...current, item];
    const size = estimateTransactionWireSize(
      feePayer,
      candidate.map(toInstruction),
    );
    if (current.length > 0 && size > SOLANA_MAX_TRANSACTION_SIZE) {
      chunks.push(current);
      current = [item];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Deployment-time configuration for the SVM composite ISM writer.
 * Passed to the writer constructor; separate from the on-chain artifact config.
 */
export type SvmCompositeIsmWriterConfig = Readonly<{
  program: SvmProgramTarget;
}>;

function bytesToH256Hex(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex');
}

/**
 * Recursively converts a wire-level `IsmNode` into the Artifact API's
 * `CompositeIsmNodeArtifactConfig` (domain-ID-keyed). `domains` is only
 * attached to whichever `routing`/`fallbackRouting` node is found — the
 * program enforces at most one such node per tree.
 */
function ismNodeToArtifactConfig(
  node: IsmNode,
  domains: Record<number, IsmNode>,
): CompositeIsmNodeArtifactConfig {
  switch (node.kind) {
    case 'trustedRelayer':
      return { type: 'trustedRelayer', relayer: node.relayer };
    case 'multisigMessageId':
      return {
        type: 'multisigMessageId',
        validators: validatorBytesToHex(node.validators),
        threshold: node.threshold,
      };
    case 'aggregation':
      return {
        type: 'aggregation',
        threshold: node.threshold,
        subIsms: node.subIsms.map((sub) =>
          ismNodeToArtifactConfig(sub, domains),
        ),
      };
    case 'test':
      return { type: 'test', accept: node.accept };
    case 'pausable':
      return { type: 'pausable', paused: node.paused };
    case 'amountRouting':
      return {
        type: 'amountRouting',
        threshold: node.threshold.toString(),
        lower: ismNodeToArtifactConfig(node.lower, domains),
        upper: ismNodeToArtifactConfig(node.upper, domains),
      };
    case 'rateLimited':
      return {
        type: 'rateLimited',
        maxCapacity: node.maxCapacity.toString(),
        mailbox: node.mailbox,
        recipient: node.recipient ? bytesToH256Hex(node.recipient) : undefined,
      };
    case 'routing':
      return {
        type: 'routing',
        domains: convertDomainsToArtifactConfig(domains),
      };
    case 'fallbackRouting':
      return {
        type: 'fallbackRouting',
        fallbackIsm: node.fallbackIsm,
        domains: convertDomainsToArtifactConfig(domains),
      };
  }
}

function convertDomainsToArtifactConfig(
  domains: Record<number, IsmNode>,
): Record<number, CompositeIsmNodeArtifactConfig> | undefined {
  const entries = Object.entries(domains);
  if (entries.length === 0) return undefined;
  const out: Record<number, CompositeIsmNodeArtifactConfig> = {};
  for (const [domainStr, ism] of entries) {
    out[Number(domainStr)] = ismNodeToArtifactConfig(ism, {});
  }
  return out;
}

/**
 * Recursively converts a `CompositeIsmNodeArtifactConfig` (Artifact API,
 * domain-ID-keyed) into a wire-level `IsmNode`, for building instructions.
 * `domains` on `routing`/`fallbackRouting` are stripped (returned separately)
 * since they're never inline on-chain — they're diffed into individual
 * `SetDomainIsm`/`RemoveDomainIsm` instructions instead.
 */
function artifactConfigToIsmNode(
  node: CompositeIsmNodeArtifactConfig,
): IsmNode {
  switch (node.type) {
    case 'trustedRelayer':
      return { kind: 'trustedRelayer', relayer: parseAddress(node.relayer) };
    case 'multisigMessageId':
      return {
        kind: 'multisigMessageId',
        validators: node.validators.map((v) => Uint8Array.from(encodeH160(v))),
        threshold: node.threshold,
      };
    case 'aggregation':
      return {
        kind: 'aggregation',
        threshold: node.threshold,
        subIsms: node.subIsms.map(artifactConfigToIsmNode),
      };
    case 'test':
      return { kind: 'test', accept: node.accept };
    case 'pausable':
      return { kind: 'pausable', paused: node.paused };
    case 'amountRouting':
      return {
        kind: 'amountRouting',
        threshold: BigInt(node.threshold),
        lower: artifactConfigToIsmNode(node.lower),
        upper: artifactConfigToIsmNode(node.upper),
      };
    case 'rateLimited': {
      const maxCapacity = BigInt(node.maxCapacity);
      return {
        kind: 'rateLimited',
        maxCapacity,
        recipient: node.recipient
          ? Uint8Array.from(encodeH256(node.recipient))
          : null,
        // Mutable state is always reset on Initialize/UpdateConfig — starts
        // full, matching the Rust CLI's `IsmNodeConfig -> IsmNode` `From` impl.
        filledLevel: maxCapacity,
        lastUpdated: 0n,
        mailbox: parseAddress(node.mailbox),
      };
    }
    case 'routing':
      return { kind: 'routing' };
    case 'fallbackRouting':
      return {
        kind: 'fallbackRouting',
        fallbackIsm: parseAddress(node.fallbackIsm),
      };
  }
}

/** Extracts the (at most one) domains map from a config tree, keyed by domain ID. */
function extractDomains(
  node: CompositeIsmNodeArtifactConfig,
): Record<number, CompositeIsmNodeArtifactConfig> {
  switch (node.type) {
    case 'routing':
    case 'fallbackRouting':
      return node.domains ?? {};
    case 'aggregation':
      for (const sub of node.subIsms) {
        const found = extractDomains(sub);
        if (Object.keys(found).length > 0) return found;
      }
      return {};
    case 'amountRouting': {
      const lower = extractDomains(node.lower);
      if (Object.keys(lower).length > 0) return lower;
      return extractDomains(node.upper);
    }
    default:
      return {};
  }
}

export class SvmCompositeIsmReader implements ArtifactReader<
  CompositeIsmArtifactConfig,
  SvmDeployedIsm
> {
  constructor(protected readonly rpc: SvmRpc) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<CompositeIsmArtifactConfig, SvmDeployedIsm>> {
    const programId = parseAddress(address);
    const { address: storagePda } =
      await deriveCompositeIsmStoragePda(programId);
    const raw = await fetchAccountDataRaw(this.rpc, storagePda);
    if (!raw) {
      throw new Error(`Composite ISM not initialized at program: ${programId}`);
    }
    const storage = decodeCompositeIsmStorageAccount(raw);
    if (!storage || !storage.root) {
      throw new Error(`Composite ISM storage empty at program: ${programId}`);
    }
    assert(
      storage.owner,
      `Composite ISM at ${programId} has no owner (ownership renounced) — not supported`,
    );

    const domains = await this.fetchDomainIsms(programId, storagePda);

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'compositeIsm',
        owner: storage.owner,
        root: ismNodeToArtifactConfig(storage.root, domains),
      },
      deployed: { address: programId, programId },
    };
  }

  protected async fetchDomainIsms(
    programId: Address,
    storagePda: Address,
  ): Promise<Record<number, IsmNode>> {
    const accounts = await this.rpc
      .getProgramAccounts(programId, { encoding: 'base64' })
      .send();

    const domains: Record<number, IsmNode> = {};
    for (const { pubkey, account } of accounts) {
      if (pubkey === storagePda) continue;
      const raw = Buffer.from(account.data[0], 'base64');
      let decoded;
      try {
        decoded = decodeDomainIsmStorageAccount(raw);
      } catch (error) {
        // This program only ever creates two account shapes (the storage
        // PDA, excluded above, and DomainIsmStorage PDAs), so a decode
        // failure here means corruption or an unrecognized future format —
        // log it rather than silently dropping the domain from the result.
        logger.warn('Failed to decode account as DomainIsmStorage', {
          pubkey,
          error,
        });
        continue;
      }
      if (decoded?.ism) {
        domains[decoded.domain] = decoded.ism;
      }
    }
    return domains;
  }
}

export class SvmCompositeIsmWriter
  extends SvmCompositeIsmReader
  implements ArtifactWriter<CompositeIsmArtifactConfig, SvmDeployedIsm>
{
  constructor(
    private readonly writerConfig: SvmCompositeIsmWriterConfig,
    rpc: SvmRpc,
    private readonly svmSigner: SvmSigner,
  ) {
    super(rpc);
  }

  async create(
    artifact: ArtifactNew<CompositeIsmArtifactConfig>,
  ): Promise<
    [ArtifactDeployed<CompositeIsmArtifactConfig, SvmDeployedIsm>, SvmReceipt[]]
  > {
    const config = artifact.config;
    const { programAddress, receipts } = await resolveProgram(
      this.writerConfig.program,
      this.svmSigner,
      this.rpc,
    );

    const domains = extractDomains(config.root);
    const rootIsmNode = artifactConfigToIsmNode(stripDomains(config.root));

    const initIx = await getInitializeCompositeIsmInstruction(
      programAddress,
      this.svmSigner.signer,
      rootIsmNode,
    );
    // skipPreflight: right after a fresh deploy, preflight simulation can
    // race the validator's program cache and reject with "Unsupported
    // program id" even though the program is actually live — same
    // workaround as SvmTestIsmWriter.create().
    receipts.push(
      await this.svmSigner.send({
        instructions: [initIx],
        skipPreflight: true,
      }),
    );

    // Domain instructions (and any other admin action) must be sent while
    // this.svmSigner.signer is still the on-chain owner — every mutating
    // instruction's account list requires the CURRENT owner as signer
    // (`ensure_owner_signer` checks against `storage.owner` as of that
    // instruction's execution). Transferring ownership first would leave
    // the deploying signer unauthorized for the domain instructions below,
    // failing them on-chain. Ownership transfer must be the last step.
    const domainEntries = Object.entries(domains);
    if (domainEntries.length > 0) {
      const domainInstructions = await Promise.all(
        domainEntries.map(([domainStr, domainConfig]) =>
          getSetCompositeIsmDomainInstruction(
            programAddress,
            this.svmSigner.signer,
            Number(domainStr),
            artifactConfigToIsmNode(domainConfig),
          ),
        ),
      );
      const chunks = chunkInstructionsBySize(
        domainInstructions,
        (ix) => ix,
        this.svmSigner.signer.address,
      );
      for (const chunk of chunks) {
        receipts.push(await this.svmSigner.send({ instructions: chunk }));
      }
    }

    const owner = parseAddress(config.owner);
    if (owner !== this.svmSigner.signer.address) {
      const transferIx = await getTransferCompositeIsmOwnershipInstruction(
        programAddress,
        this.svmSigner.signer,
        owner,
      );
      receipts.push(await this.svmSigner.send({ instructions: [transferIx] }));
    }

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config,
        deployed: { address: programAddress, programId: programAddress },
      },
      receipts,
    ];
  }

  async update(
    artifact: ArtifactDeployed<CompositeIsmArtifactConfig, SvmDeployedIsm>,
  ): Promise<AnnotatedSvmTransaction[]> {
    const programId = artifact.deployed.programId;
    const expected = artifact.config;
    const current = await this.read(programId);

    const transactions: AnnotatedSvmTransaction[] = [];

    const expectedRootStripped = stripDomains(expected.root);
    const currentRootStripped = stripDomains(current.config.root);
    let rootTx: AnnotatedSvmTransaction | undefined;
    if (!deepEqualNode(expectedRootStripped, currentRootStripped)) {
      const ix = await getUpdateCompositeIsmConfigInstruction(
        programId,
        this.svmSigner.signer,
        artifactConfigToIsmNode(expectedRootStripped),
      );
      rootTx = {
        feePayer: this.svmSigner.signer.address,
        instructions: [ix],
        annotation: 'Update composite ISM config',
      };
    }

    const expectedDomains = extractDomains(expected.root);
    // Domain PDAs survive UpdateConfig independently of the current root's
    // shape (a routing root's per-domain overrides are separate accounts
    // that aren't deleted when the root is later updated to a non-routing
    // type) — diff against the raw on-chain domain map, not
    // extractDomains(current.config.root), which is empty whenever the
    // current root itself isn't routing/fallbackRouting (or doesn't nest
    // one), and would otherwise leave stale domains un-removed and silently
    // reactivated the next time the root becomes routing again.
    const { address: storagePda } =
      await deriveCompositeIsmStoragePda(programId);
    const rawCurrentDomains = await this.fetchDomainIsms(programId, storagePda);
    const currentDomains: Record<number, CompositeIsmNodeArtifactConfig> = {};
    for (const [domainStr, ismNode] of Object.entries(rawCurrentDomains)) {
      currentDomains[Number(domainStr)] = ismNodeToArtifactConfig(ismNode, {});
    }

    const domainIxs: {
      instruction: Awaited<
        ReturnType<typeof getSetCompositeIsmDomainInstruction>
      >;
      annotation: string;
    }[] = [];
    for (const [domainStr, domainConfig] of Object.entries(expectedDomains)) {
      const domain = Number(domainStr);
      const currentDomainConfig = currentDomains[domain];
      if (
        currentDomainConfig &&
        deepEqualNode(domainConfig, currentDomainConfig)
      ) {
        continue;
      }
      domainIxs.push({
        instruction: await getSetCompositeIsmDomainInstruction(
          programId,
          this.svmSigner.signer,
          domain,
          artifactConfigToIsmNode(domainConfig),
        ),
        annotation: `Set composite ISM domain ${domain}`,
      });
    }
    for (const domainStr of Object.keys(currentDomains)) {
      const domain = Number(domainStr);
      if (expectedDomains[domain]) continue;
      domainIxs.push({
        instruction: await getRemoveCompositeIsmDomainInstruction(
          programId,
          this.svmSigner.signer,
          domain,
        ),
        annotation: `Remove composite ISM domain ${domain}`,
      });
    }

    const domainIxChunks = chunkInstructionsBySize(
      domainIxs,
      (item) => item.instruction,
      this.svmSigner.signer.address,
    );
    const domainTxs: AnnotatedSvmTransaction[] = domainIxChunks.map(
      (chunk) => ({
        feePayer: this.svmSigner.signer.address,
        instructions: chunk.map((c) => c.instruction),
        annotation: chunk.map((c) => c.annotation).join(', '),
      }),
    );

    // Ordering matters: activating routing/fallbackRouting from a
    // non-routing root immediately exposes every domain PDA that currently
    // exists on-chain (including stale ones). If the root update were sent
    // before the domain reconciliation and the domain transactions then
    // failed to send (partial apply), a stale domain would be briefly — or
    // indefinitely — live. Reconcile domains first when routing is being
    // activated; when routing is being disabled (or the root isn't
    // changing type), the existing root-then-domains order is fine, since
    // domain PDAs are unreachable once the root is non-routing regardless
    // of when they're cleaned up.
    const isRoutingType = (type: CompositeIsmNodeArtifactConfig['type']) =>
      type === 'routing' || type === 'fallbackRouting';
    const activatingRouting =
      !isRoutingType(currentRootStripped.type) &&
      isRoutingType(expectedRootStripped.type);

    if (activatingRouting) {
      transactions.push(...domainTxs);
      if (rootTx) transactions.push(rootTx);
    } else {
      if (rootTx) transactions.push(rootTx);
      transactions.push(...domainTxs);
    }

    // Ownership transfer must be the last transaction: every other
    // instruction above requires `this.svmSigner.signer` to still be the
    // on-chain owner (`ensure_owner_signer` checks against `storage.owner`
    // at execution time), so transferring first would leave the signer
    // unauthorized for the root/domain updates built above.
    const expectedOwner = parseAddress(expected.owner);
    const currentOwner = parseAddress(current.config.owner);
    if (expectedOwner !== currentOwner) {
      const ix = await getTransferCompositeIsmOwnershipInstruction(
        programId,
        this.svmSigner.signer,
        expectedOwner,
      );
      transactions.push({
        feePayer: this.svmSigner.signer.address,
        instructions: [ix],
        annotation: 'Transfer composite ISM ownership',
      });
    }

    return transactions;
  }

  /** Sets every `Pausable` node in the tree to paused. */
  async pause(programId: Address): Promise<AnnotatedSvmTransaction> {
    const ix = await getPauseCompositeIsmInstruction(
      programId,
      this.svmSigner.signer,
    );
    return {
      feePayer: this.svmSigner.signer.address,
      instructions: [ix],
      annotation: 'Pause composite ISM',
    };
  }

  /** Sets every `Pausable` node in the tree to unpaused. */
  async unpause(programId: Address): Promise<AnnotatedSvmTransaction> {
    const ix = await getUnpauseCompositeIsmInstruction(
      programId,
      this.svmSigner.signer,
    );
    return {
      feePayer: this.svmSigner.signer.address,
      instructions: [ix],
      annotation: 'Unpause composite ISM',
    };
  }
}

/** Returns a copy of `node` with any `domains` map on it (or nested) stripped. */
function stripDomains(
  node: CompositeIsmNodeArtifactConfig,
): CompositeIsmNodeArtifactConfig {
  switch (node.type) {
    case 'routing':
      return { type: 'routing' };
    case 'fallbackRouting':
      return { type: 'fallbackRouting', fallbackIsm: node.fallbackIsm };
    case 'aggregation':
      return {
        ...node,
        subIsms: node.subIsms.map(stripDomains),
      };
    case 'amountRouting':
      return {
        ...node,
        lower: stripDomains(node.lower),
        upper: stripDomains(node.upper),
      };
    default:
      return node;
  }
}

function deepEqualNode(
  a: CompositeIsmNodeArtifactConfig,
  b: CompositeIsmNodeArtifactConfig,
): boolean {
  return deepEquals(normalizeForCompare(a), normalizeForCompare(b));
}

/**
 * Recursively normalizes case/order/formatting-only differences (hex
 * validator addresses, recipient hash, decimal string capacity/threshold) so
 * `deepEqualNode` doesn't report a false "changed" for a node nested
 * anywhere in the tree — not just at the outermost call — which would
 * otherwise make `update()` never converge to a no-op diff for trees
 * containing `multisigMessageId`/`rateLimited` below an
 * `aggregation`/`amountRouting` node. Decimal strings in particular must be
 * canonicalized (e.g. config-supplied `"086400"` vs on-chain `"86400"`) —
 * on-chain `UpdateConfig` resets a `rateLimited` node's `filledLevel` to
 * full capacity, so an uncanonicalized false diff would cause every
 * `apply` to needlessly refill the limiter.
 */
function normalizeForCompare(node: CompositeIsmNodeArtifactConfig): unknown {
  switch (node.type) {
    case 'multisigMessageId':
      return {
        ...node,
        validators: [...node.validators].map((v) => v.toLowerCase()).sort(),
      };
    case 'rateLimited':
      return {
        ...node,
        maxCapacity: BigInt(node.maxCapacity).toString(),
        recipient: node.recipient?.toLowerCase(),
      };
    case 'aggregation':
      return { ...node, subIsms: node.subIsms.map(normalizeForCompare) };
    case 'amountRouting':
      return {
        ...node,
        threshold: BigInt(node.threshold).toString(),
        lower: normalizeForCompare(node.lower),
        upper: normalizeForCompare(node.upper),
      };
    default:
      return node;
  }
}
