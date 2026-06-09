import { address as parseAddress, type Address } from '@solana/kit';

import {
  type ArtifactDeployed,
  type ArtifactNew,
  ArtifactComposition,
  ArtifactState,
  type EmbeddedArtifactWriter,
  type WithCompositionVariant,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedIsmAddress,
  RawRoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  assert,
  retryAsync,
  rootLogger,
  ZERO_ADDRESS_HEX_32,
} from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import {
  INIT_RETRY_ATTEMPTS,
  INIT_RETRY_BASE_MS,
  isProgramDeploymentRace,
  toProgramDeploymentError,
} from '../deploy/program-deploy-race.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import {
  getInitializeMultisigIsmMessageIdInstruction,
  getSetValidatorsAndThresholdInstruction,
  getTransferOwnershipInstruction,
} from '../instructions/multisig-ism-message-id.js';
import { deriveMultisigIsmDomainDataPda } from '../pda.js';
import type {
  AnnotatedSvmTransaction,
  SvmDeployedIsm,
  SvmProgramTarget,
  SvmReceipt,
  SvmRpc,
} from '../types.js';

import { fetchMultisigIsmAccessControl } from './ism-query.js';
import {
  decodeRoutingMultisigAccounts,
  fetchRoutingMultisigAccounts,
  SvmRoutingMultisigReader,
} from './routing-multisig-reader.js';

type EmbeddedRoutingMultisigConfig = WithCompositionVariant<
  RawRoutingIsmArtifactConfig,
  typeof ArtifactComposition.EMBEDDED
>;

/**
 * Deployment-time configuration for the SVM routing multisig writer.
 * Mirrors `SvmTestIsmWriterConfig`: deployment knobs live in the constructor,
 * the on-chain artifact lives in the `create`/`update` argument.
 */
export type SvmRoutingMultisigWriterConfig = Readonly<{
  /** How to obtain the deployed program: fresh bytes or pre-existing ID. */
  program: SvmProgramTarget;
  /**
   * Superset of domain ids that may have a DomainData PDA on-chain. Used by
   * `update()` to enumerate live domains (DomainData stores no domain id in
   * its payload — the seed is the only source of truth). The expected
   * config's domain set is implicitly included; pass any previously-deployed
   * domain ids here to make orphan detection fire when expected drops them.
   */
  candidateDomains?: readonly number[];
}>;

interface DomainMultisig {
  validators: string[];
  threshold: number;
}

/**
 * SVM "routing multisig" — a single multisig-ism program account whose state
 * is a per-domain map of validators/threshold. Modeled as an EMBEDDED routing
 * ISM: the program is the parent, each domain's DomainData PDA is a child.
 */
export class SvmRoutingMultisigWriter implements EmbeddedArtifactWriter<
  RawRoutingIsmArtifactConfig,
  SvmDeployedIsm
> {
  readonly composition = ArtifactComposition.EMBEDDED;

  private readonly logger = rootLogger.child({
    module: 'SvmRoutingMultisigWriter',
  });
  private readonly reader: SvmRoutingMultisigReader;

  constructor(
    private readonly writerConfig: SvmRoutingMultisigWriterConfig,
    private readonly rpc: SvmRpc,
    private readonly svmSigner: SvmSigner,
  ) {
    this.reader = new SvmRoutingMultisigReader(
      rpc,
      writerConfig.candidateDomains,
    );
  }

  async read(
    address: string,
  ): Promise<ArtifactDeployed<EmbeddedRoutingMultisigConfig, SvmDeployedIsm>> {
    return this.reader.read(address);
  }

  // create() is fire-and-forget by design — the EmbeddedArtifactWriter
  // interface returns `[deployed, TxReceipt[]]`, not `AnnotatedTx[]`. Post-
  // deploy steps (init + per-domain SetValidators + optional Transfer
  // Ownership) reference the freshly-deployed programId, so the program must
  // be deployed before the rest can be assembled. Droppable AnnotatedTx
  // emission is the `update()` path's job; `create()` writes a green-field
  // artifact and reports receipts.
  async create(
    artifact: ArtifactNew<EmbeddedRoutingMultisigConfig>,
  ): Promise<
    [
      ArtifactDeployed<EmbeddedRoutingMultisigConfig, SvmDeployedIsm>,
      SvmReceipt[],
    ]
  > {
    const config = artifact.config;
    const { programAddress: programId, receipts } = await resolveProgram(
      this.writerConfig.program,
      this.svmSigner,
      this.rpc,
    );

    const accessControl = await fetchMultisigIsmAccessControl(
      this.rpc,
      programId,
    );

    if (accessControl === null) {
      const initIx = await getInitializeMultisigIsmMessageIdInstruction(
        programId,
        this.svmSigner.signer,
      );
      // The deploy ack/init race is non-deterministic on some clusters; mark
      // non-race failures as terminal so retryAsync stops retrying immediately.
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
    }

    const deployerAddress = this.svmSigner.signer.address;
    const desiredOwner = parseAddress(config.owner);
    if (desiredOwner !== deployerAddress) {
      const transferIx = await getTransferOwnershipInstruction(
        programId,
        this.svmSigner.signer,
        desiredOwner,
      );
      receipts.push(await this.svmSigner.send({ instructions: [transferIx] }));
    }

    const domainChildren: Record<
      number,
      ArtifactDeployed<
        EmbeddedRoutingMultisigConfig['domains'][number]['config'],
        DeployedIsmAddress
      >
    > = {};
    for (const [domainStr, domainArtifact] of Object.entries(config.domains)) {
      const domain = parseDomain(domainStr);
      const domainConfig = domainArtifact.config;
      assert(
        domainConfig.type === 'messageIdMultisigIsm' ||
          domainConfig.type === 'merkleRootMultisigIsm',
        `Routing multisig writer only supports multisig ISM children, got type=${domainConfig.type} for domain ${domain}`,
      );

      const ix = await getSetValidatorsAndThresholdInstruction({
        programAddress: programId,
        owner: this.svmSigner.signer,
        domain,
        validators: domainConfig.validators,
        threshold: domainConfig.threshold,
      });
      receipts.push(await this.svmSigner.send({ instructions: [ix] }));

      const { address: domainPda } = await deriveMultisigIsmDomainDataPda(
        programId,
        domain,
      );
      domainChildren[domain] = {
        artifactState: ArtifactState.DEPLOYED,
        config: domainConfig,
        deployed: { address: domainPda },
      };
    }

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          composition: ArtifactComposition.EMBEDDED,
          type: 'domainRoutingIsm',
          owner: config.owner,
          domains: domainChildren,
        },
        deployed: { address: programId, programId },
      },
      receipts,
    ];
  }

  async update(
    artifact: ArtifactDeployed<EmbeddedRoutingMultisigConfig, SvmDeployedIsm>,
  ): Promise<AnnotatedSvmTransaction[]> {
    const programId = artifact.deployed.programId;
    const expectedConfig = artifact.config;

    // Enumerate every account owned by the multisig program. DomainData PDAs
    // don't carry their domain id in the payload, so we match them by
    // re-deriving each candidate domain's PDA. Candidates = the writer's
    // configured set ∪ the expected config's domains. Any DomainData PDA
    // that doesn't match a candidate falls into `unmatchedDomainAccounts`,
    // and we surface that as a warning so previously-deployed domains
    // outside the candidate set are visible to operators.
    const accounts = await fetchRoutingMultisigAccounts(this.rpc, programId);
    const expectedDomainIds = Object.keys(expectedConfig.domains).map((d) =>
      parseDomain(d),
    );
    const candidateDomains = unionDomains(
      this.writerConfig.candidateDomains ?? [],
      expectedDomainIds,
    );

    const { accessControl, domains, unmatchedDomainAccounts } =
      await decodeRoutingMultisigAccounts(
        programId,
        accounts,
        candidateDomains,
      );

    if (unmatchedDomainAccounts.length > 0) {
      this.logger.warn(
        `Routing multisig at ${programId}: ${unmatchedDomainAccounts.length} on-chain domain account(s) did not match any candidate domain; pass them via writer config candidateDomains so update() can reconcile or report them`,
        { programId, unmatchedDomainAccounts },
      );
    }

    const currentOwner = accessControl.owner ?? ZERO_ADDRESS_HEX_32;
    const currentDomains: Record<number, DomainMultisig> = {};
    for (const [domainStr, child] of Object.entries(domains)) {
      const domain = parseDomain(domainStr);
      assert(
        child.config.type === 'messageIdMultisigIsm' ||
          child.config.type === 'merkleRootMultisigIsm',
        `Routing multisig at ${programId} domain ${domain} decoded as unexpected type ${child.config.type}`,
      );
      currentDomains[domain] = {
        validators: child.config.validators,
        threshold: child.config.threshold,
      };
    }

    return computeRoutingMultisigUpdate({
      programId,
      signer: this.svmSigner.signer,
      currentOwner,
      currentDomains,
      expectedConfig,
    });
  }
}

function unionDomains(a: readonly number[], b: readonly number[]): number[] {
  const set = new Set<number>(a);
  for (const v of b) set.add(v);
  return Array.from(set);
}

interface ComputeRoutingMultisigUpdateArgs {
  programId: Address;
  signer: SvmSigner['signer'];
  currentOwner: string;
  currentDomains: Record<number, DomainMultisig>;
  expectedConfig: EmbeddedRoutingMultisigConfig;
}

/**
 * Pure helper: given current on-chain state and expected config, produce the
 * ordered list of reconciliation transactions. One tx per logical step so
 * users can drop any single step at export-review time
 * (see [emit-droppable-tx-steps]).
 *
 * Throws when the expected config drops a domain that exists on-chain — a
 * silent drop would leave orphan PDAs (see [accuracy-over-approximation]).
 */
export async function computeRoutingMultisigUpdate(
  args: ComputeRoutingMultisigUpdateArgs,
): Promise<AnnotatedSvmTransaction[]> {
  const { programId, signer, currentOwner, currentDomains, expectedConfig } =
    args;

  const txs: AnnotatedSvmTransaction[] = [];
  const ownerAddress = parseAddress(currentOwner);

  const expectedDomains: Record<number, DomainMultisig> = {};
  for (const [domainStr, domainArtifact] of Object.entries(
    expectedConfig.domains,
  )) {
    const domain = parseDomain(domainStr);
    const cfg = domainArtifact.config;
    assert(
      cfg.type === 'messageIdMultisigIsm' ||
        cfg.type === 'merkleRootMultisigIsm',
      `Routing multisig writer only supports multisig ISM children, got type=${cfg.type} for domain ${domain}`,
    );
    expectedDomains[domain] = {
      validators: cfg.validators,
      threshold: cfg.threshold,
    };
  }

  const orphanDomains = Object.keys(currentDomains)
    .map((d) => parseDomain(d))
    .filter((d) => !(d in expectedDomains));
  assert(
    orphanDomains.length === 0,
    `Routing multisig at ${programId} has on-chain domains not present in expected config: [${orphanDomains.join(', ')}]. ` +
      `Domain removal is not supported (would leave orphan PDAs); update the expected config to include them or redeploy.`,
  );

  if (expectedConfig.owner !== currentOwner) {
    const newOwner = parseAddress(expectedConfig.owner);
    const ix = await getTransferOwnershipInstruction(
      programId,
      signer,
      newOwner,
    );
    txs.push({
      feePayer: ownerAddress,
      instructions: [ix],
      annotation: `Transfer routing multisig ownership to ${newOwner}`,
    });
  }

  for (const [domainStr, expected] of Object.entries(expectedDomains)) {
    const domain = parseDomain(domainStr);
    const current = currentDomains[domain];
    if (current && multisigEquals(current, expected)) continue;

    const ix = await getSetValidatorsAndThresholdInstruction({
      programAddress: programId,
      owner: signer,
      domain,
      validators: expected.validators,
      threshold: expected.threshold,
    });
    txs.push({
      feePayer: ownerAddress,
      instructions: [ix],
      annotation: `Set validators/threshold for domain ${domain}`,
    });
  }

  return txs;
}

function parseDomain(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(value);
  assert(
    Number.isInteger(n) && n >= 0,
    `Invalid domain id: '${String(value)}'`,
  );
  return n;
}

function multisigEquals(a: DomainMultisig, b: DomainMultisig): boolean {
  if (a.threshold !== b.threshold) return false;
  if (a.validators.length !== b.validators.length) return false;
  const aSet = new Set(a.validators.map((v) => v.toLowerCase()));
  for (const v of b.validators) {
    if (!aSet.has(v.toLowerCase())) return false;
  }
  return true;
}
