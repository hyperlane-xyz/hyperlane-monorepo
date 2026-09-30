import {
  address as parseAddress,
  generateKeyPairSigner,
  isAddress,
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
import {
  type DomainMultisigConfig,
  type RoutingMessageIdMultisigIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  ZERO_ADDRESS_HEX_32,
  assert,
  deepEquals,
  difference,
  eqAddressSol,
  eqOptionalAddress,
  isEmptyAddress,
  isZeroishAddress,
  type NonEmptyArray,
  nonEmptyArray,
  normalizeConfig,
  retryAsync,
} from '@hyperlane-xyz/utils';

import { encodeH160 } from '../codecs/shared.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import {
  MAX_ROUTING_MESSAGE_ID_MULTISIG_THRESHOLD,
  MAX_ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_PER_DOMAIN,
  ROUTING_MESSAGE_ID_MULTISIG_SIGNATURES_HARD_LIMIT,
  ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_HARD_LIMIT,
  getInitializeMultisigIsmMessageIdInstruction,
  getSetValidatorsAndThresholdInstruction,
  getTransferOwnershipInstruction,
} from '../instructions/multisig-ism-message-id.js';
import {
  SOLANA_MAX_TRANSACTION_SIZE,
  chunkInstructionsBySize,
  estimateTransactionWireSize,
} from '../tx.js';
import type { SvmSigner } from '../clients/signer.js';
import type {
  AnnotatedSvmTransaction,
  SvmDeployedIsm,
  SvmProgramTarget,
  SvmReceipt,
  SvmRpc,
} from '../types.js';

import {
  fetchMultisigIsmAccessControl,
  fetchMultisigIsmDomainsData,
  validatorBytesToHex,
} from './ism-query.js';

const INIT_RETRY_ATTEMPTS = 8;
const INIT_RETRY_BASE_MS = 1000;
const MAX_DOMAIN_ID = 0xffffffffn;
const MAX_THRESHOLD = 255;

type ProgramDeploymentError = Error & {
  context?: { logs?: string[] };
  isRecoverable?: boolean;
};

function toProgramDeploymentError(error: unknown): ProgramDeploymentError {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function isProgramDeploymentRace(error: unknown): boolean {
  const logs = toProgramDeploymentError(error).context?.logs;
  return !!logs?.some(
    (log) =>
      log.includes('Program is not deployed') ||
      log.includes('invalid account data for instruction'),
  );
}

type RoutingMessageIdMultisigIsmArtifact = ArtifactDeployed<
  RoutingMessageIdMultisigIsmArtifactConfig,
  SvmDeployedIsm
>;

export type SvmRoutingMessageIdMultisigIsmWriterConfig = Readonly<{
  program: SvmProgramTarget;
}>;

/**
 * Mirrors the program's per-domain ValidatorsAndThreshold::validate()
 * (rust/sealevel/programs/ism/multisig-ism-message-id/src/instruction.rs),
 * plus the caps derived from the measured transaction-size limits.
 */
function assertValidDomainMultisig(
  domain: string,
  { validators, threshold }: DomainMultisigConfig,
): void {
  assert(
    /^(0|[1-9]\d*)$/.test(domain) && BigInt(domain) <= MAX_DOMAIN_ID,
    `Invalid multisig ISM domain: '${domain}'`,
  );
  assert(
    validators.length <= MAX_ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_PER_DOMAIN,
    `Multisig ISM domain ${domain} has ${validators.length} validators, above the enforced cap of ${MAX_ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_PER_DOMAIN} (a set of more than ${ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_HARD_LIMIT} cannot be written in one transaction)`,
  );
  assert(
    Number.isInteger(threshold) &&
      threshold >= 1 &&
      threshold <= MAX_THRESHOLD &&
      threshold <= validators.length,
    `Multisig ISM domain ${domain} threshold (${threshold}) must be an integer between 1 and min(${MAX_THRESHOLD}, validators.length)`,
  );
  assert(
    threshold <= MAX_ROUTING_MESSAGE_ID_MULTISIG_THRESHOLD,
    `Multisig ISM domain ${domain} threshold (${threshold}) is above the enforced cap of ${MAX_ROUTING_MESSAGE_ID_MULTISIG_THRESHOLD} (a Verify transaction fits at most ${ROUTING_MESSAGE_ID_MULTISIG_SIGNATURES_HARD_LIMIT} signatures)`,
  );
  const seen = new Set<string>();
  for (const validator of validators) {
    try {
      encodeH160(validator);
    } catch {
      assert(
        false,
        `Multisig ISM domain ${domain} has an invalid H160 validator address: ${validator}`,
      );
    }
    const normalized = validator.toLowerCase();
    assert(
      !seen.has(normalized),
      `Multisig ISM domain ${domain} has a duplicate validator address: ${validator}`,
    );
    seen.add(normalized);
  }
}

export function assertValidRoutingMessageIdMultisigIsmArtifact(
  config: RoutingMessageIdMultisigIsmArtifactConfig,
): void {
  assert(
    isEmptyAddress(config.owner) || isAddress(config.owner),
    `Multisig ISM owner must be a Sealevel address or empty (renounced), got: ${config.owner}`,
  );
  for (const [domain, domainConfig] of Object.entries(config.domains)) {
    assertValidDomainMultisig(domain, domainConfig);
  }
}

export interface SetDomainItem {
  domain: number;
  instruction: Instruction;
}

/** Defense in depth behind the caps: fails naming the domain, not at send time. */
export function chunkSetDomainItems(
  items: readonly SetDomainItem[],
  feePayer: Address,
) {
  for (const item of items) {
    const size = estimateTransactionWireSize(feePayer, [item.instruction]);
    assert(
      size <= SOLANA_MAX_TRANSACTION_SIZE,
      `Multisig ISM domain ${item.domain} instruction (${size} bytes) exceeds Solana's ${SOLANA_MAX_TRANSACTION_SIZE}-byte transaction size limit`,
    );
  }
  return chunkInstructionsBySize(items, (item) => item.instruction, feePayer);
}

function expectedDomainEntries(
  config: RoutingMessageIdMultisigIsmArtifactConfig,
): [number, DomainMultisigConfig][] {
  return Object.entries(config.domains).map(([domain, domainConfig]) => [
    Number(domain),
    domainConfig,
  ]);
}

async function buildSetDomainItems(
  programAddress: Address,
  owner: Address,
  entries: readonly [number, DomainMultisigConfig][],
): Promise<SetDomainItem[]> {
  return Promise.all(
    entries.map(async ([domain, domainConfig]) => ({
      domain,
      instruction: await getSetValidatorsAndThresholdInstruction({
        programAddress,
        owner,
        domain,
        validators: domainConfig.validators,
        threshold: domainConfig.threshold,
      }),
    })),
  );
}

/**
 * Domain PDAs can't be enumerated, so only `knownDomainIds` are probed. Reads
 * and the writer's `update()` domain-drop detection are only as complete as
 * that list: a domain that is configured on chain but omitted stays configured
 * silently.
 */
export class SvmRoutingMessageIdMultisigIsmReader implements ArtifactReader<
  RoutingMessageIdMultisigIsmArtifactConfig,
  SvmDeployedIsm
> {
  constructor(
    protected readonly rpc: SvmRpc,
    protected readonly knownDomainIds: NonEmptyArray<number>,
  ) {}

  async read(address: string): Promise<RoutingMessageIdMultisigIsmArtifact> {
    const programId = parseAddress(address);
    const accessControl = await fetchMultisigIsmAccessControl(
      this.rpc,
      programId,
    );
    assert(
      accessControl !== null,
      `Multisig ISM not initialized at program: ${programId}`,
    );

    const domainsData = await fetchMultisigIsmDomainsData(
      this.rpc,
      programId,
      this.knownDomainIds,
    );
    const domains: Record<number, DomainMultisigConfig> = {};
    for (const [domain, data] of Object.entries(domainsData)) {
      const validators = validatorBytesToHex(
        data.validatorsAndThreshold.validators,
      );
      assert(
        validators.length > 0,
        `Corrupt multisig ISM domain ${domain} at program ${programId}: on-chain validator set is empty (the program never creates one)`,
      );
      domains[Number(domain)] = {
        validators: nonEmptyArray(validators),
        threshold: data.validatorsAndThreshold.threshold,
      };
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'routingMessageIdMultisigIsm',
        owner: accessControl.owner ?? ZERO_ADDRESS_HEX_32,
        domains,
      },
      deployed: { address: programId, programId },
    };
  }
}

export class SvmRoutingMessageIdMultisigIsmWriter
  extends SvmRoutingMessageIdMultisigIsmReader
  implements
    ArtifactWriter<RoutingMessageIdMultisigIsmArtifactConfig, SvmDeployedIsm>
{
  constructor(
    private readonly writerConfig: SvmRoutingMessageIdMultisigIsmWriterConfig,
    rpc: SvmRpc,
    private readonly svmSigner: SvmSigner,
    knownDomainIds: NonEmptyArray<number>,
  ) {
    super(rpc, knownDomainIds);
  }

  /**
   * Only the configured domains are written and returned: when an already
   * initialized program is reused, domains already on chain are left untouched
   * and not reported.
   *
   * Transactions are sized for direct or export submission (one transaction
   * including the compute-budget instruction); a Squads proposal wraps
   * instructions and has different limits.
   *
   * Transfers OWNERSHIP (`config.owner`) but not the program upgrade
   * authority, which stays with the deploying key like the other SVM writers.
   * Callers that need it moved must do so separately, and a redeploy triggered
   * by a dropped domain (deploy-sdk core/warp writers) leaves the authority
   * with the deployer until transferred.
   */
  async create(
    artifact: ArtifactNew<RoutingMessageIdMultisigIsmArtifactConfig>,
  ): Promise<[RoutingMessageIdMultisigIsmArtifact, SvmReceipt[]]> {
    const config = artifact.config;
    assertValidRoutingMessageIdMultisigIsmArtifact(config);

    const signerAddress = this.svmSigner.signer.address;
    const domainEntries = expectedDomainEntries(config);

    // Placeholder program: fail on an oversized domain before deploying.
    const { address: placeholderProgramId } = await generateKeyPairSigner();
    chunkSetDomainItems(
      await buildSetDomainItems(
        placeholderProgramId,
        signerAddress,
        domainEntries,
      ),
      signerAddress,
    );

    const { programAddress, receipts } = await resolveProgram(
      this.writerConfig.program,
      this.svmSigner,
      this.rpc,
    );

    const accessControl = await fetchMultisigIsmAccessControl(
      this.rpc,
      programAddress,
    );

    if (accessControl === null) {
      const initIx = await getInitializeMultisigIsmMessageIdInstruction(
        programAddress,
        this.svmSigner.signer,
      );
      const initReceipt = await retryAsync(
        async () => {
          try {
            return await this.svmSigner.send({ instructions: [initIx] });
          } catch (error) {
            const wrapped = toProgramDeploymentError(error);
            if (isProgramDeploymentRace(wrapped)) throw wrapped;
            wrapped.isRecoverable = false;
            throw wrapped;
          }
        },
        INIT_RETRY_ATTEMPTS,
        INIT_RETRY_BASE_MS,
      );
      receipts.push(initReceipt);
    } else {
      assert(
        accessControl.owner !== null &&
          eqAddressSol(accessControl.owner, signerAddress),
        `Multisig ISM ${programAddress} is already initialized and not owned by the deploying signer`,
      );
    }

    // Every mutating instruction requires the CURRENT owner as signer, so
    // ownership transfer must be the last step.
    const chunks = chunkSetDomainItems(
      await buildSetDomainItems(programAddress, signerAddress, domainEntries),
      signerAddress,
    );
    for (const chunk of chunks) {
      receipts.push(
        await this.svmSigner.send({
          instructions: chunk.map((item) => item.instruction),
        }),
      );
    }

    const expectedOwner = isEmptyAddress(config.owner)
      ? null
      : parseAddress(config.owner);
    if (!eqOptionalAddress(signerAddress, config.owner, eqAddressSol)) {
      const transferIx = await getTransferOwnershipInstruction(
        programAddress,
        signerAddress,
        expectedOwner,
      );
      receipts.push(await this.svmSigner.send({ instructions: [transferIx] }));
    }

    const domains: Record<number, DomainMultisigConfig> = {};
    for (const [domain, { validators, threshold }] of domainEntries) {
      domains[domain] = {
        validators: nonEmptyArray(
          validatorBytesToHex(
            validators.map((validator) =>
              Uint8Array.from(encodeH160(validator)),
            ),
          ),
        ),
        threshold,
      };
    }

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'routingMessageIdMultisigIsm',
          owner: expectedOwner ?? ZERO_ADDRESS_HEX_32,
          domains,
        },
        deployed: { address: programAddress, programId: programAddress },
      },
      receipts,
    ];
  }

  /**
   * Adds or changes per-domain validator sets and transfers ownership. The
   * program has no remove-domain instruction, so a domain that exists on chain
   * and is missing from the expected config is rejected; callers deploy a new
   * ISM in that case (see `shouldDeployNewIsm` in provider-sdk).
   *
   * Chunking assumes direct or export submission (one transaction including
   * the compute-budget instruction); a Squads proposal wraps instructions and
   * has different limits. The on-chain OWNER pays the rent for new DomainData
   * PDAs, so it must hold lamports when the returned transactions are sent.
   */
  async update(
    artifact: RoutingMessageIdMultisigIsmArtifact,
  ): Promise<AnnotatedSvmTransaction[]> {
    const programId = artifact.deployed.programId;
    const expected = artifact.config;
    assertValidRoutingMessageIdMultisigIsmArtifact(expected);
    const current = await this.read(programId);

    assert(
      !isZeroishAddress(current.config.owner),
      `Cannot update multisig ISM ${programId}: ISM has no owner`,
    );
    const ownerAddress = parseAddress(current.config.owner);
    const expectedOwner = isEmptyAddress(expected.owner)
      ? null
      : parseAddress(expected.owner);

    const [droppedDomain] = difference(
      new Set(Object.keys(current.config.domains)),
      new Set(Object.keys(expected.domains)),
    );
    assert(
      droppedDomain === undefined,
      `Cannot remove domain ${droppedDomain} from multisig ISM ${programId}: the program has no remove-domain instruction, deploy a new ISM instead`,
    );

    // normalizeConfig ignores validator order and case: an order-only change
    // is never applied, matching the other ISM diffs.
    const changedEntries = expectedDomainEntries(expected).filter(
      ([domain, domainConfig]) =>
        !deepEquals(
          normalizeConfig(current.config.domains[domain]),
          normalizeConfig(domainConfig),
        ),
    );

    const transactions: AnnotatedSvmTransaction[] = [];
    const chunks = chunkSetDomainItems(
      await buildSetDomainItems(programId, ownerAddress, changedEntries),
      ownerAddress,
    );
    for (const chunk of chunks) {
      transactions.push({
        feePayer: ownerAddress,
        instructions: chunk.map((item) => item.instruction),
        annotation: `Set multisig ISM validators for domains ${chunk
          .map((item) => item.domain)
          .join(', ')}`,
      });
    }

    // Last: the instructions above require the current owner as signer.
    if (
      !eqOptionalAddress(current.config.owner, expected.owner, eqAddressSol)
    ) {
      transactions.push({
        feePayer: ownerAddress,
        instructions: [
          await getTransferOwnershipInstruction(
            programId,
            ownerAddress,
            expectedOwner,
          ),
        ],
        annotation: 'Transfer multisig ISM ownership',
      });
    }

    return transactions;
  }
}
