import { address as parseAddress, type Address } from '@solana/kit';

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
import { assert, rootLogger } from '@hyperlane-xyz/utils';

import {
  decodeCompositeIsmStorageAccount,
  decodeDomainIsmStorageAccount,
  type IsmNode,
} from '../accounts/composite-ism.js';
import { encodeH160, encodeH256 } from '../codecs/shared.js';
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
import type { SvmSigner } from '../clients/signer.js';
import type {
  AnnotatedSvmTransaction,
  SvmDeployedIsm,
  SvmProgramTarget,
  SvmReceipt,
  SvmRpc,
} from '../types.js';

import { validatorBytesToHex } from './ism-query.js';

const CHUNK_SIZE = 5;
const logger = rootLogger.child({ module: 'composite-ism' });

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

  private async fetchDomainIsms(
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
      for (let i = 0; i < domainInstructions.length; i += CHUNK_SIZE) {
        const chunk = domainInstructions.slice(i, i + CHUNK_SIZE);
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
    if (!deepEqualNode(expectedRootStripped, currentRootStripped)) {
      const ix = await getUpdateCompositeIsmConfigInstruction(
        programId,
        this.svmSigner.signer,
        artifactConfigToIsmNode(expectedRootStripped),
      );
      transactions.push({
        feePayer: this.svmSigner.signer.address,
        instructions: [ix],
        annotation: 'Update composite ISM config',
      });
    }

    const expectedDomains = extractDomains(expected.root);
    const currentDomains = extractDomains(current.config.root);

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

    for (let i = 0; i < domainIxs.length; i += CHUNK_SIZE) {
      const chunk = domainIxs.slice(i, i + CHUNK_SIZE);
      transactions.push({
        feePayer: this.svmSigner.signer.address,
        instructions: chunk.map((c) => c.instruction),
        annotation: chunk.map((c) => c.annotation).join(', '),
      });
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
  return (
    JSON.stringify(normalizeForCompare(a)) ===
    JSON.stringify(normalizeForCompare(b))
  );
}

/**
 * Recursively normalizes case/order-only differences (hex validator
 * addresses, recipient hash) so `deepEqualNode` doesn't report a false
 * "changed" for a node nested anywhere in the tree — not just at the
 * outermost call — which would otherwise make `update()` never converge
 * to a no-op diff for trees containing `multisigMessageId`/`rateLimited`
 * below an `aggregation`/`amountRouting` node.
 */
function normalizeForCompare(node: CompositeIsmNodeArtifactConfig): unknown {
  switch (node.type) {
    case 'multisigMessageId':
      return {
        ...node,
        validators: [...node.validators].map((v) => v.toLowerCase()).sort(),
      };
    case 'rateLimited':
      return { ...node, recipient: node.recipient?.toLowerCase() };
    case 'aggregation':
      return { ...node, subIsms: node.subIsms.map(normalizeForCompare) };
    case 'amountRouting':
      return {
        ...node,
        lower: normalizeForCompare(node.lower),
        upper: normalizeForCompare(node.upper),
      };
    default:
      return node;
  }
}
