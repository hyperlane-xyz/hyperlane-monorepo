import { address as parseAddress } from '@solana/kit';

import {
  FeeType,
  FeeStrategyType,
  type FeeReadContext,
  type FeeStrategy,
  type RoutingFeeArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/fee';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  assert,
  eqAddressSol,
  eqOptionalAddress,
  isZeroishAddress,
  ZERO_ADDRESS_HEX_32,
} from '@hyperlane-xyz/utils';

import type { RouteDomainData } from '../accounts/fee.js';
import type { SvmSigner } from '../clients/signer.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import {
  getInitFeeInstruction,
  getRemoveRouteInstruction,
  getSetBeneficiaryInstruction,
  getSetRouteInstruction,
  getSetWildcardQuoteSignersInstruction,
  getTransferFeeOwnershipInstruction,
} from '../instructions/fee.js';
import { deriveFeeAccountPda } from '../pda.js';
import type { AnnotatedSvmTransaction, SvmReceipt, SvmRpc } from '../types.js';

import { fetchFeeAccount, fetchRouteDomain } from './fee-query.js';
import {
  DEFAULT_FEE_SALT,
  FeeDataKind,
  FeeStrategyKind,
  h160ToSigner,
  signerToH160,
  type SvmDeployedFee,
  type SvmFeeWriterConfig,
} from './types.js';

// ── Helpers: map on-chain route data <-> provider-sdk FeeStrategy ───

function routeDomainToFeeStrategy(route: RouteDomainData): FeeStrategy {
  const { maxFee, halfAmount } = route.feeData.params;
  const base = {
    maxFee: maxFee.toString(),
    halfAmount: halfAmount.toString(),
  };

  if (route.signers !== null && route.signers.length > 0) {
    return {
      type: FeeStrategyType.offchainQuotedLinear,
      ...base,
      quoteSigners: route.signers.map(h160ToSigner),
    };
  }

  switch (route.feeData.kind) {
    case FeeStrategyKind.Linear:
      return { type: FeeStrategyType.linear, ...base };
    case FeeStrategyKind.Regressive:
      return { type: FeeStrategyType.regressive, ...base };
    case FeeStrategyKind.Progressive:
      return { type: FeeStrategyType.progressive, ...base };
    default: {
      const _exhaustive: never = route.feeData;
      throw new Error(`Unknown strategy kind: ${_exhaustive}`);
    }
  }
}

function feeStrategyToOnChain(strategy: FeeStrategy): {
  feeData: {
    kind: FeeStrategyKind;
    params: { maxFee: bigint; halfAmount: bigint };
  };
  signers: Uint8Array[] | null;
} {
  const params = {
    maxFee: BigInt(strategy.maxFee),
    halfAmount: BigInt(strategy.halfAmount),
  };

  switch (strategy.type) {
    case FeeStrategyType.linear:
      return {
        feeData: { kind: FeeStrategyKind.Linear, params },
        signers: null,
      };
    case FeeStrategyType.regressive:
      return {
        feeData: { kind: FeeStrategyKind.Regressive, params },
        signers: null,
      };
    case FeeStrategyType.progressive:
      return {
        feeData: { kind: FeeStrategyKind.Progressive, params },
        signers: null,
      };
    case FeeStrategyType.offchainQuotedLinear:
      return {
        feeData: { kind: FeeStrategyKind.Linear, params },
        signers: strategy.quoteSigners.map(signerToH160),
      };
  }
}

function computeWildcardSigners(
  routes: Record<number, FeeStrategy>,
): Uint8Array[] {
  const union = new Set<string>();
  for (const strategy of Object.values(routes)) {
    if (strategy.type === FeeStrategyType.offchainQuotedLinear) {
      for (const s of strategy.quoteSigners) {
        union.add(s.toLowerCase());
      }
    }
  }
  return [...union].sort().map(signerToH160);
}

// ── Reader ──────────────────────────────────────────────────────────

export class SvmRoutingFeeReader implements ArtifactReader<
  RoutingFeeArtifactConfig,
  SvmDeployedFee
> {
  constructor(
    protected readonly rpc: SvmRpc,
    protected readonly context: FeeReadContext,
    protected readonly salt: Uint8Array = DEFAULT_FEE_SALT,
  ) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<RoutingFeeArtifactConfig, SvmDeployedFee>> {
    const programId = parseAddress(address);
    const account = await fetchFeeAccount(this.rpc, programId, this.salt);
    assert(account, `Fee account not found for program: ${programId}`);
    assert(
      account.feeData.kind === FeeDataKind.Routing,
      `Expected Routing fee data, got kind ${account.feeData.kind}`,
    );

    const { address: feeAccountPda } = await deriveFeeAccountPda(
      programId,
      this.salt,
    );

    // Route PDAs are not enumerable on-chain — use context to know which domains to query.
    const routes: Record<number, FeeStrategy> = {};
    for (const domainStr of Object.keys(this.context.knownRoutersPerDomain)) {
      const domain = Number(domainStr);
      const route = await fetchRouteDomain(
        this.rpc,
        programId,
        feeAccountPda,
        domain,
      );
      if (route) {
        routes[domain] = routeDomainToFeeStrategy(route);
      }
    }

    const owner: string = account.owner ?? ZERO_ADDRESS_HEX_32;
    const beneficiary: string = account.beneficiary;

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: { type: FeeType.routing, owner, beneficiary, routes },
      deployed: { address: programId, programId, feeAccountPda },
    };
  }
}

// ── Writer ──────────────────────────────────────────────────────────

export class SvmRoutingFeeWriter
  extends SvmRoutingFeeReader
  implements ArtifactWriter<RoutingFeeArtifactConfig, SvmDeployedFee>
{
  constructor(
    private readonly writerConfig: SvmFeeWriterConfig,
    rpc: SvmRpc,
    private readonly domainId: number,
    private readonly svmSigner: SvmSigner,
    context: FeeReadContext,
    salt: Uint8Array = DEFAULT_FEE_SALT,
  ) {
    super(rpc, context, salt);
  }

  async create(
    artifact: ArtifactNew<RoutingFeeArtifactConfig>,
  ): Promise<
    [ArtifactDeployed<RoutingFeeArtifactConfig, SvmDeployedFee>, SvmReceipt[]]
  > {
    const feeConfig = artifact.config;
    const { programAddress: programId, receipts } = await resolveProgram(
      this.writerConfig.program,
      this.svmSigner,
      this.rpc,
    );

    const wildcardSigners = computeWildcardSigners(feeConfig.routes);

    const initIx = await getInitFeeInstruction(
      programId,
      this.svmSigner.signer.address,
      {
        salt: this.salt,
        beneficiary: parseAddress(feeConfig.beneficiary),
        feeData: {
          kind: FeeDataKind.Routing,
          config: { wildcardSigners },
        },
        domainId: this.domainId,
      },
    );

    const initReceipt = await this.svmSigner.send({
      instructions: [initIx],
      skipPreflight: true,
    });
    receipts.push(initReceipt);

    const { address: feeAccountPda } = await deriveFeeAccountPda(
      programId,
      this.salt,
    );

    for (const [domainStr, strategy] of Object.entries(feeConfig.routes)) {
      const domain = Number(domainStr);
      const { feeData, signers } = feeStrategyToOnChain(strategy);
      const setRouteIx = await getSetRouteInstruction(
        programId,
        feeAccountPda,
        this.svmSigner.signer.address,
        domain,
        feeData,
        signers,
      );
      const routeReceipt = await this.svmSigner.send({
        instructions: [setRouteIx],
        skipPreflight: true,
      });
      receipts.push(routeReceipt);
    }

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: feeConfig,
        deployed: { address: programId, programId, feeAccountPda },
      },
      receipts,
    ];
  }

  async update(
    artifact: ArtifactDeployed<RoutingFeeArtifactConfig, SvmDeployedFee>,
  ): Promise<AnnotatedSvmTransaction[]> {
    const txs: AnnotatedSvmTransaction[] = [];
    const expected = artifact.config;
    const { programId, feeAccountPda } = artifact.deployed;

    const current = await this.read(programId);
    const currentConfig = current.config;

    assert(
      !isZeroishAddress(currentConfig.owner),
      'Cannot update fee: fee account has no owner',
    );
    const ownerAddress = parseAddress(currentConfig.owner);

    const expectedDomains = new Set(Object.keys(expected.routes).map(Number));
    const currentDomains = new Set(
      Object.keys(currentConfig.routes).map(Number),
    );

    // Phase 1: Add or update routes
    for (const domain of expectedDomains) {
      const { feeData, signers } = feeStrategyToOnChain(
        expected.routes[domain]!,
      );
      txs.push({
        feePayer: ownerAddress,
        instructions: [
          await getSetRouteInstruction(
            programId,
            feeAccountPda,
            ownerAddress,
            domain,
            feeData,
            signers,
          ),
        ],
        annotation: `Set route for domain ${domain}`,
      });
    }

    // Phase 2: Remove stale routes
    for (const domain of currentDomains) {
      if (!expectedDomains.has(domain)) {
        txs.push({
          feePayer: ownerAddress,
          instructions: [
            await getRemoveRouteInstruction(
              programId,
              feeAccountPda,
              ownerAddress,
              domain,
            ),
          ],
          annotation: `Remove route for domain ${domain}`,
        });
      }
    }

    // Phase 3: Update wildcard signers
    const wildcardSigners = computeWildcardSigners(expected.routes);
    txs.push({
      feePayer: ownerAddress,
      instructions: [
        getSetWildcardQuoteSignersInstruction(
          programId,
          feeAccountPda,
          ownerAddress,
          wildcardSigners,
        ),
      ],
      annotation: 'Update wildcard quote signers',
    });

    // Phase 4: Diff beneficiary
    if (!eqAddressSol(currentConfig.beneficiary, expected.beneficiary)) {
      txs.push({
        feePayer: ownerAddress,
        instructions: [
          getSetBeneficiaryInstruction(
            programId,
            feeAccountPda,
            ownerAddress,
            parseAddress(expected.beneficiary),
          ),
        ],
        annotation: 'Update fee beneficiary',
      });
    }

    // Phase 5: Diff owner (always last)
    if (!eqOptionalAddress(currentConfig.owner, expected.owner, eqAddressSol)) {
      const newOwner =
        expected.owner && !isZeroishAddress(expected.owner)
          ? parseAddress(expected.owner)
          : null;
      txs.push({
        feePayer: ownerAddress,
        instructions: [
          getTransferFeeOwnershipInstruction(
            programId,
            feeAccountPda,
            ownerAddress,
            newOwner,
          ),
        ],
        annotation: 'Transfer fee ownership',
      });
    }

    return txs;
  }
}
