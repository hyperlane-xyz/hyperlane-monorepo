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
  ArtifactComposition,
  ArtifactState,
  type OrchestratedArtifactReader,
  type OrchestratedArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  assert,
  eqAddressSol,
  eqOptionalAddress,
  isZeroishAddress,
  objMap,
  ZERO_ADDRESS_HEX_32,
} from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import { addressBytes, ensureLength } from '../codecs/binary.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import {
  buildBeneficiaryAtaIx,
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
  feeStrategiesEqual,
  feeStrategyToOnChain,
  h160SetEquality,
  routeDataToFeeStrategy,
} from './fee-strategy-utils.js';
import {
  FeeDataKind,
  parseDomainId,
  type WithWildcardSigners,
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

/**
 * On-chain CC route PDAs are non-enumerable, so `read()` only discovers routes
 * for (domain, router) pairs listed in `context.knownRoutersPerDomain`.
 * `update()` diffs against this same view — routes for pairs absent from the
 * context are invisible and won't be added or removed. Callers must ensure the
 * context covers all active (domain, router) pairs to avoid partial diffs.
 */
export class SvmCrossCollateralRoutingFeeReader implements OrchestratedArtifactReader<
  WithWildcardSigners<CrossCollateralRoutingFeeArtifactConfig>,
  SvmDeployedFee
> {
  readonly composition = ArtifactComposition.ORCHESTRATED;

  constructor(
    protected readonly rpc: SvmRpc,
    protected readonly context: FeeReadContext,
    protected readonly salt: Uint8Array,
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      WithWildcardSigners<CrossCollateralRoutingFeeArtifactConfig>,
      SvmDeployedFee
    >
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
      const domain = parseDomainId(domainStr);
      for (const router of routerSet) {
        const route = await fetchCrossCollateralRoute(
          this.rpc,
          programId,
          feeAccountPda,
          domain,
          routerToBytes(router),
        );

        if (route) {
          routes[domain] ??= {};
          routes[domain][router.toLowerCase()] = routeDataToFeeStrategy(route);
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
        wildcardSigners: account.feeData.wildcardSigners,
      },
      deployed: { address: programId, programId, feeAccountPda },
    };
  }
}

export class SvmCrossCollateralRoutingFeeWriter
  extends SvmCrossCollateralRoutingFeeReader
  implements
    OrchestratedArtifactWriter<
      CrossCollateralRoutingFeeArtifactConfig,
      SvmDeployedFee
    >
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
      true,
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

    // Ensure the beneficiary's ATA exists when the fee config carries the
    // settlement asset. No-op when `token` is undefined (native flows) or
    // when the ATA already exists on chain.
    const initAtaIx = await buildBeneficiaryAtaIx({
      rpc: this.rpc,
      payer: this.svmSigner.signer.address,
      beneficiary: parseAddress(feeConfig.beneficiary),
      feeToken: feeConfig.token,
    });
    if (initAtaIx) {
      receipts.push(await this.svmSigner.send({ instructions: [initAtaIx] }));
    }

    // Set each CC route via SetRemoteFeeRoute(target_router = Some)
    for (const [domainStr, routerMap] of Object.entries(feeConfig.routes)) {
      const domain = parseDomainId(domainStr);
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

    if (
      !eqOptionalAddress(
        this.svmSigner.signer.address,
        feeConfig.owner,
        eqAddressSol,
      )
    ) {
      const newOwner =
        feeConfig.owner && !isZeroishAddress(feeConfig.owner)
          ? parseAddress(feeConfig.owner)
          : null;
      receipts.push(
        await this.svmSigner.send({
          instructions: [
            getTransferFeeOwnershipInstruction(
              programId,
              feeAccountPda,
              this.svmSigner.signer.address,
              newOwner,
            ),
          ],
        }),
      );
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

    // Normalize expected router keys to lowercase up front — read() lowercases
    // keys in currentConfig.routes, so both sides need canonical casing to diff.
    const expectedRoutes = objMap(expected.routes, (_domain, routerMap) =>
      Object.fromEntries(
        Object.entries(routerMap).map(([r, s]) => [r.toLowerCase(), s]),
      ),
    );

    // 1. Add or update CC routes
    for (const [domainStr, routerMap] of Object.entries(expectedRoutes)) {
      const domain = parseDomainId(domainStr);
      for (const [router, strategy] of Object.entries(routerMap)) {
        const currentStrategy = currentConfig.routes[domain]?.[router];
        if (currentStrategy && feeStrategiesEqual(currentStrategy, strategy)) {
          continue;
        }
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
    for (const [domainStr, routerMap] of Object.entries(currentConfig.routes)) {
      const domain = parseDomainId(domainStr);
      for (const router of Object.keys(routerMap)) {
        if (!expectedRoutes[domain]?.[router]) {
          txs.push({
            feePayer: ownerAddress,
            instructions: [
              await getRemoveRemoteFeeRouteInstruction(
                programId,
                feeAccountPda,
                ownerAddress,
                domain,
                routerToBytes(router),
              ),
            ],
            annotation: `Remove CC route for domain ${domain} router ${router.slice(0, 10)}...`,
          });
        }
      }
    }

    // 3. Update wildcard signers
    const wildcardSigners = computeWildcardSignersFromStrategies(
      allCCStrategies(expectedRoutes),
    );
    if (!h160SetEquality(currentConfig.wildcardSigners, wildcardSigners)) {
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
    }

    // 4. Diff beneficiary + ensure beneficiary's ATA exists when token is set.
    const expectedBeneficiary = parseAddress(expected.beneficiary);
    // payer = current on-chain owner: every tx generated by the artifact
    // API's update path is paid for and signed by the owner, since the
    // owner is the only authority that can mutate the artifact. The
    // create path uses the deployer as payer because there is no on-chain
    // owner yet — that asymmetry is the design invariant, not a bug.
    const ataIx = await buildBeneficiaryAtaIx({
      rpc: this.rpc,
      payer: ownerAddress,
      beneficiary: expectedBeneficiary,
      feeToken: expected.token,
    });
    const beneficiaryChanged = !eqAddressSol(
      currentConfig.beneficiary,
      expected.beneficiary,
    );

    if (beneficiaryChanged) {
      const setBeneficiaryIx = getSetBeneficiaryInstruction(
        programId,
        feeAccountPda,
        ownerAddress,
        expectedBeneficiary,
      );
      txs.push({
        feePayer: ownerAddress,
        instructions: ataIx ? [ataIx, setBeneficiaryIx] : [setBeneficiaryIx],
        annotation: ataIx
          ? 'Update fee beneficiary and create ata'
          : 'Update fee beneficiary',
      });
    } else if (ataIx) {
      txs.push({
        feePayer: ownerAddress,
        instructions: [ataIx],
        annotation: 'Create beneficiary ata',
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
