import { address as parseAddress } from '@solana/kit';

import {
  FeeType,
  type CrossCollateralRoutingFeeArtifactConfig,
  type FeeReadContext,
  type FeeStrategy,
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

import { addressBytes, ensureLength } from '../codecs/binary.js';
import type { SvmSigner } from '../clients/signer.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import {
  getInitFeeInstruction,
  getRemoveCrossCollateralRouteInstruction,
  getSetBeneficiaryInstruction,
  getSetCrossCollateralRouteInstruction,
  getSetWildcardQuoteSignersInstruction,
  getTransferFeeOwnershipInstruction,
} from '../instructions/fee.js';
import { deriveFeeAccountPda } from '../pda.js';
import type { AnnotatedSvmTransaction, SvmReceipt, SvmRpc } from '../types.js';

import { fetchCrossCollateralRoute, fetchFeeAccount } from './fee-query.js';
import {
  computeWildcardSignersFromStrategies,
  feeStrategyToOnChain,
  routeDataToFeeStrategy,
} from './fee-strategy-utils.js';
import {
  DEFAULT_FEE_SALT,
  FeeDataKind,
  type SvmDeployedFee,
  type SvmFeeWriterConfig,
} from './types.js';

/** Convert a hex router address string to a 32-byte Uint8Array (H256). */
function routerToBytes(router: string): Uint8Array {
  return Uint8Array.from(ensureLength(addressBytes(router), 32, 'H256 router'));
}

/** Collect all FeeStrategy values from the nested CC routes map. */
function allCCStrategies(
  routes: Record<number, Record<string, FeeStrategy>>,
): FeeStrategy[] {
  const result: FeeStrategy[] = [];
  for (const routerMap of Object.values(routes)) {
    for (const strategy of Object.values(routerMap)) {
      result.push(strategy);
    }
  }
  return result;
}

// ── Reader ──────────────────────────────────────────────────────────

export class SvmCrossCollateralRoutingFeeReader implements ArtifactReader<
  CrossCollateralRoutingFeeArtifactConfig,
  SvmDeployedFee
> {
  constructor(
    protected readonly rpc: SvmRpc,
    protected readonly context: FeeReadContext,
    protected readonly salt: Uint8Array = DEFAULT_FEE_SALT,
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<CrossCollateralRoutingFeeArtifactConfig, SvmDeployedFee>
  > {
    const programId = parseAddress(address);
    const account = await fetchFeeAccount(this.rpc, programId, this.salt);
    assert(account, `Fee account not found for program: ${programId}`);
    assert(
      account.feeData.kind === FeeDataKind.CrossCollateralRouting,
      `Expected CrossCollateralRouting fee data, got kind ${account.feeData.kind}`,
    );

    const { address: feeAccountPda } = await deriveFeeAccountPda(
      programId,
      this.salt,
    );

    // CC route PDAs are not enumerable on-chain — use context for (domain, router) pairs.
    const routes: Record<number, Record<string, FeeStrategy>> = {};
    for (const [domainStr, routerSet] of Object.entries(
      this.context.knownRoutersPerDomain,
    )) {
      const domain = Number(domainStr);
      for (const router of routerSet) {
        const route = await fetchCrossCollateralRoute(
          this.rpc,
          programId,
          feeAccountPda,
          domain,
          routerToBytes(router),
        );
        if (route) {
          if (!routes[domain]) routes[domain] = {};
          routes[domain][router] = routeDataToFeeStrategy(route);
        }
      }
    }

    const owner: string = account.owner ?? ZERO_ADDRESS_HEX_32;
    const beneficiary: string = account.beneficiary;

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: FeeType.crossCollateralRouting,
        owner,
        beneficiary,
        routes,
      },
      deployed: { address: programId, programId, feeAccountPda },
    };
  }
}

// ── Writer ──────────────────────────────────────────────────────────

export class SvmCrossCollateralRoutingFeeWriter
  extends SvmCrossCollateralRoutingFeeReader
  implements
    ArtifactWriter<CrossCollateralRoutingFeeArtifactConfig, SvmDeployedFee>
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
    artifact: ArtifactNew<CrossCollateralRoutingFeeArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<CrossCollateralRoutingFeeArtifactConfig, SvmDeployedFee>,
      SvmReceipt[],
    ]
  > {
    const feeConfig = artifact.config;
    const { programAddress: programId, receipts } = await resolveProgram(
      this.writerConfig.program,
      this.svmSigner,
      this.rpc,
    );

    const wildcardSigners = computeWildcardSignersFromStrategies(
      allCCStrategies(feeConfig.routes),
    );

    const initIx = await getInitFeeInstruction(
      programId,
      this.svmSigner.signer.address,
      {
        salt: this.salt,
        beneficiary: parseAddress(feeConfig.beneficiary),
        feeData: {
          kind: FeeDataKind.CrossCollateralRouting,
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

    // Set each CC route
    for (const [domainStr, routerMap] of Object.entries(feeConfig.routes)) {
      const domain = Number(domainStr);
      for (const [router, strategy] of Object.entries(routerMap)) {
        const { feeData, signers } = feeStrategyToOnChain(strategy);
        const setRouteIx = await getSetCrossCollateralRouteInstruction(
          programId,
          feeAccountPda,
          this.svmSigner.signer.address,
          domain,
          routerToBytes(router),
          feeData,
          signers,
        );
        const routeReceipt = await this.svmSigner.send({
          instructions: [setRouteIx],
          skipPreflight: true,
        });
        receipts.push(routeReceipt);
      }
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
    artifact: ArtifactDeployed<
      CrossCollateralRoutingFeeArtifactConfig,
      SvmDeployedFee
    >,
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

    // Build sets of (domain, router) keys for current and expected
    const expectedKeys = new Set<string>();
    for (const [domainStr, routerMap] of Object.entries(expected.routes)) {
      for (const router of Object.keys(routerMap)) {
        expectedKeys.add(`${domainStr}:${router}`);
      }
    }
    const currentKeys = new Set<string>();
    for (const [domainStr, routerMap] of Object.entries(currentConfig.routes)) {
      for (const router of Object.keys(routerMap)) {
        currentKeys.add(`${domainStr}:${router}`);
      }
    }

    // Phase 1: Add or update CC routes
    for (const [domainStr, routerMap] of Object.entries(expected.routes)) {
      const domain = Number(domainStr);
      for (const [router, strategy] of Object.entries(routerMap)) {
        const { feeData, signers } = feeStrategyToOnChain(strategy);
        txs.push({
          feePayer: ownerAddress,
          instructions: [
            await getSetCrossCollateralRouteInstruction(
              programId,
              feeAccountPda,
              ownerAddress,
              domain,
              routerToBytes(router),
              feeData,
              signers,
            ),
          ],
          annotation: `Set CC route for domain ${domain} router ${router.slice(0, 10)}...`,
        });
      }
    }

    // Phase 2: Remove stale CC routes
    for (const key of currentKeys) {
      if (!expectedKeys.has(key)) {
        const [domainStr, router] = key.split(':');
        txs.push({
          feePayer: ownerAddress,
          instructions: [
            await getRemoveCrossCollateralRouteInstruction(
              programId,
              feeAccountPda,
              ownerAddress,
              Number(domainStr),
              routerToBytes(router!),
            ),
          ],
          annotation: `Remove CC route for domain ${domainStr} router ${router!.slice(0, 10)}...`,
        });
      }
    }

    // Phase 3: Update wildcard signers
    const wildcardSigners = computeWildcardSignersFromStrategies(
      allCCStrategies(expected.routes),
    );
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
