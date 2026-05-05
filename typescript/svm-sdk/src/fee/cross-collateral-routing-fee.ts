import { address as parseAddress } from '@solana/kit';

import {
  type CrossCollateralRoutingFeeArtifactConfig,
  type FeeReadContext,
  type FeeStrategy,
  FeeType,
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

import type { SvmSigner } from '../clients/signer.js';
import { addressBytes, ensureLength } from '../codecs/binary.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import {
  getInitFeeInstruction,
  getRemoveRemoteFeeRouteInstruction,
  getSetBeneficiaryInstruction,
  getSetRemoteFeeRouteInstruction,
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
  FeeDataKind,
  type SvmDeployedFee,
  type SvmFeeWriterConfig,
} from './types.js';

function routerToBytes(router: string): Uint8Array {
  return Uint8Array.from(ensureLength(addressBytes(router), 32, 'H256 router'));
}

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

export class SvmCrossCollateralRoutingFeeReader implements ArtifactReader<
  CrossCollateralRoutingFeeArtifactConfig,
  SvmDeployedFee
> {
  constructor(
    protected readonly rpc: SvmRpc,
    protected readonly context: FeeReadContext,
    protected readonly salt: Uint8Array,
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

    // CC route PDAs are non-enumerable — use context for (domain, router) pairs.
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
          routes[domain]![router] = routeDataToFeeStrategy(route);
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
    salt: Uint8Array,
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
      this.svmSigner.signer,
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

    receipts.push(
      await this.svmSigner.send({
        instructions: [initIx],
        skipPreflight: true,
      }),
    );

    const { address: feeAccountPda } = await deriveFeeAccountPda(
      programId,
      this.salt,
    );

    // Set each CC route via SetRemoteFeeRoute(target_router = Some)
    for (const [domainStr, routerMap] of Object.entries(feeConfig.routes)) {
      const domain = Number(domainStr);
      for (const [router, strategy] of Object.entries(routerMap)) {
        const { feeData, signers } = feeStrategyToOnChain(strategy);
        const setRouteIx = await getSetRemoteFeeRouteInstruction(
          programId,
          feeAccountPda,
          this.svmSigner.signer.address,
          domain,
          routerToBytes(router),
          feeData,
          signers,
        );
        receipts.push(
          await this.svmSigner.send({
            instructions: [setRouteIx],
            skipPreflight: true,
          }),
        );
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

    // Build sets of (domain, router) pairs for diff
    const expectedPairs = new Set<string>();
    for (const [domainStr, routerMap] of Object.entries(expected.routes)) {
      for (const router of Object.keys(routerMap)) {
        expectedPairs.add(`${domainStr}:${router}`);
      }
    }

    const currentPairs = new Set<string>();
    for (const [domainStr, routerMap] of Object.entries(currentConfig.routes)) {
      for (const router of Object.keys(routerMap)) {
        currentPairs.add(`${domainStr}:${router}`);
      }
    }

    // 1. Add or update CC routes
    for (const [domainStr, routerMap] of Object.entries(expected.routes)) {
      const domain = Number(domainStr);
      for (const [router, strategy] of Object.entries(routerMap)) {
        const { feeData, signers } = feeStrategyToOnChain(strategy);
        txs.push({
          feePayer: ownerAddress,
          instructions: [
            await getSetRemoteFeeRouteInstruction(
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

    // 2. Remove stale CC routes
    for (const pair of currentPairs) {
      if (!expectedPairs.has(pair)) {
        const [domainStr, router] = pair.split(':');
        txs.push({
          feePayer: ownerAddress,
          instructions: [
            await getRemoveRemoteFeeRouteInstruction(
              programId,
              feeAccountPda,
              ownerAddress,
              Number(domainStr),
              routerToBytes(router!),
            ),
          ],
          annotation: `Remove CC route for domain ${domainStr}`,
        });
      }
    }

    // 3. Update wildcard signers
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

    // 4. Diff beneficiary
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

    // 5. Diff owner (always last)
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
