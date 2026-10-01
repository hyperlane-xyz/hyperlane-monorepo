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
  type DeployedIsmAddress,
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
  ROUTING_MESSAGE_ID_MULTISIG_SQUADS_WRAPPING_RESERVED_BYTES,
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
 * (rust/sealevel/programs/ism/multisig-ism-message-id/src/instruction.rs).
 */
function assertValidDomainStructure(
  domain: string,
  { validators, threshold }: DomainMultisigConfig,
): void {
  assert(
    /^(0|[1-9]\d*)$/.test(domain) && BigInt(domain) <= MAX_DOMAIN_ID,
    `Invalid multisig ISM domain: '${domain}'`,
  );
  assert(
    Number.isInteger(threshold) &&
      threshold >= 1 &&
      threshold <= validators.length,
    `Multisig ISM domain ${domain} threshold (${threshold}) must be an integer between 1 and validators.length`,
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

/**
 * Caps derived from the measured transaction-size limits. They only constrain
 * what is written, so they are not applied to domains already on chain.
 */
function assertDomainWithinTransactionCaps(
  domain: string,
  { validators, threshold }: DomainMultisigConfig,
): void {
  assert(
    validators.length <= MAX_ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_PER_DOMAIN,
    `Multisig ISM domain ${domain} has ${validators.length} validators, above the enforced cap of ${MAX_ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_PER_DOMAIN} (a set of more than ${ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_HARD_LIMIT} cannot be written in one transaction)`,
  );
  assert(
    threshold <= MAX_ROUTING_MESSAGE_ID_MULTISIG_THRESHOLD,
    `Multisig ISM domain ${domain} threshold (${threshold}) is above the enforced cap of ${MAX_ROUTING_MESSAGE_ID_MULTISIG_THRESHOLD} (a Verify transaction fits at most ${ROUTING_MESSAGE_ID_MULTISIG_SIGNATURES_HARD_LIMIT} signatures)`,
  );
}

export function assertValidRoutingMessageIdMultisigIsmStructure(
  config: RoutingMessageIdMultisigIsmArtifactConfig,
): void {
  assert(
    isEmptyAddress(config.owner) || isAddress(config.owner),
    `Multisig ISM owner must be a Sealevel address or empty (renounced), got: ${config.owner}`,
  );
  for (const [domain, domainConfig] of Object.entries(config.domains)) {
    assertValidDomainStructure(domain, domainConfig);
  }
}

/** Structure plus the transaction-size caps on every domain, for new ISMs. */
export function assertValidRoutingMessageIdMultisigIsmArtifact(
  config: RoutingMessageIdMultisigIsmArtifactConfig,
): void {
  assertValidRoutingMessageIdMultisigIsmStructure(config);
  for (const [domain, domainConfig] of Object.entries(config.domains)) {
    assertDomainWithinTransactionCaps(domain, domainConfig);
  }
}

export interface SetDomainItem {
  domain: number;
  instruction: Instruction;
}

/**
 * Batches fit both a direct transaction and a Squads proposal wrapping them
 * (see {@link ROUTING_MESSAGE_ID_MULTISIG_SQUADS_WRAPPING_RESERVED_BYTES}).
 * Defense in depth behind the caps: fails naming the domain, not at send time.
 */
export function chunkSetDomainItems(
  items: readonly SetDomainItem[],
  feePayer: Address,
) {
  const maxSize =
    SOLANA_MAX_TRANSACTION_SIZE -
    ROUTING_MESSAGE_ID_MULTISIG_SQUADS_WRAPPING_RESERVED_BYTES;
  for (const item of items) {
    const size = estimateTransactionWireSize(feePayer, [item.instruction]);
    assert(
      size <= maxSize,
      `Multisig ISM domain ${item.domain} instruction (${size} bytes) exceeds the ${maxSize}-byte limit that keeps it within Solana's ${SOLANA_MAX_TRANSACTION_SIZE}-byte transaction size limit when wrapped in a Squads proposal`,
    );
  }
  return chunkInstructionsBySize(
    items,
    (item) => item.instruction,
    feePayer,
    ROUTING_MESSAGE_ID_MULTISIG_SQUADS_WRAPPING_RESERVED_BYTES,
  );
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
 * Domain PDAs can't be enumerated, so only `knownDomainIds` are probed (the
 * writer's `update()` additionally probes the domains named by the expected
 * config). Reads and `update()` domain-drop detection are only as complete as
 * those lists: a domain that is configured on chain but in neither stays
 * configured silently.
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
    return this.readDomains(address, this.knownDomainIds);
  }

  protected async readDomains(
    address: string,
    domainIds: readonly number[],
  ): Promise<RoutingMessageIdMultisigIsmArtifact> {
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
      domainIds,
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
   * Rerunning with `{ programBytes }` after a partial failure deploys a fresh
   * program and orphans the half-configured one; rerunning with `{ programId }`
   * resumes it (an initialized program owned by the signer skips init).
   *
   * Only the configured domains are written and returned: when an already
   * initialized program is reused, domains already on chain are left untouched
   * and not reported.
   *
   * Transactions are chunked so that each also fits a Squads proposal wrapping
   * it (see {@link ROUTING_MESSAGE_ID_MULTISIG_SQUADS_WRAPPING_RESERVED_BYTES}),
   * so a direct submission may use slightly more transactions than its own
   * size limit requires.
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
        accessControl.owner !== null,
        `Multisig ISM ${programAddress} is already initialized and its ownership was renounced`,
      );
      assert(
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
   * The transaction-size caps on validators and threshold apply only to the
   * domains being added or changed: a domain already on chain above them (set
   * under an older cap or by other tooling) is left alone when unchanged.
   *
   * Transactions are chunked so that each also fits a Squads proposal wrapping
   * it (see {@link ROUTING_MESSAGE_ID_MULTISIG_SQUADS_WRAPPING_RESERVED_BYTES}),
   * so a direct submission may use slightly more transactions than its own
   * size limit requires. The on-chain OWNER pays the rent for new DomainData
   * PDAs, so it must hold lamports when the returned transactions are sent.
   *
   * A renounced (zero-owner) ISM can no longer be changed: update() returns no
   * transactions when it already matches the expected config and throws
   * when any change (domain or ownership) would be needed.
   */
  async update(
    artifact: ArtifactDeployed<
      RoutingMessageIdMultisigIsmArtifactConfig,
      DeployedIsmAddress
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    const programId = parseAddress(artifact.deployed.address);
    const expected = artifact.config;
    assertValidRoutingMessageIdMultisigIsmStructure(expected);
    const current = await this.readDomains(programId, [
      ...this.knownDomainIds,
      ...Object.keys(expected.domains).map(Number),
    ]);

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
    // is never applied, matching the other ISM diffs. The on-chain order still
    // matters: verification wants signatures in it, and a fresh write keeps the
    // given order.
    const changedEntries = expectedDomainEntries(expected).filter(
      ([domain, domainConfig]) =>
        !deepEquals(
          normalizeConfig(current.config.domains[domain]),
          normalizeConfig(domainConfig),
        ),
    );
    for (const [domain, domainConfig] of changedEntries) {
      assertDomainWithinTransactionCaps(String(domain), domainConfig);
    }

    const ownerChanged = !eqOptionalAddress(
      current.config.owner,
      expected.owner,
      eqAddressSol,
    );

    // A renounced ISM is terminal: the only reconcile is a no-op, like a
    // frozen ALT.
    if (isZeroishAddress(current.config.owner)) {
      assert(
        changedEntries.length === 0,
        `Cannot update domains ${changedEntries
          .map(([domain]) => domain)
          .join(', ')} of multisig ISM ${programId}: ownership was renounced`,
      );
      assert(
        !ownerChanged,
        `Cannot transfer ownership of multisig ISM ${programId}: ownership was renounced`,
      );
      return [];
    }

    const ownerAddress = parseAddress(current.config.owner);
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
    if (ownerChanged) {
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
