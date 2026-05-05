import { address as parseAddress } from '@solana/kit';

import {
  FeeType,
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

import type { SvmSigner } from '../clients/signer.js';
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

import { fetchFeeAccount, fetchRouteDomain } from './fee-query.js';
import {
  computeWildcardSignersFromStrategies,
  feeStrategiesEqual,
  feeStrategyToOnChain,
  h160SetEquality,
  routeDataToFeeStrategy,
} from './fee-strategy-utils.js';
import {
  FeeDataKind,
  type SvmDeployedFee,
  type SvmFeeWriterConfig,
} from './types.js';

export class SvmRoutingFeeReader implements ArtifactReader<
  RoutingFeeArtifactConfig,
  SvmDeployedFee
> {
  constructor(
    protected readonly rpc: SvmRpc,
    protected readonly context: FeeReadContext,
    protected readonly salt: Uint8Array,
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

    // Route PDAs are non-enumerable on-chain — use context to discover domains.
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
        routes[domain] = routeDataToFeeStrategy(route);
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
    salt: Uint8Array,
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

    const wildcardSigners = computeWildcardSignersFromStrategies(
      Object.values(feeConfig.routes),
    );

    const initIx = await getInitFeeInstruction(
      programId,
      this.svmSigner.signer,
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

    // Set each route via SetRemoteFeeRoute (target_router = null for Routing)
    for (const [domainStr, strategy] of Object.entries(feeConfig.routes)) {
      const domain = Number(domainStr);
      const { feeData, signers } = feeStrategyToOnChain(strategy);
      const setRouteIx = await getSetRemoteFeeRouteInstruction(
        programId,
        feeAccountPda,
        this.svmSigner.signer.address,
        domain,
        null,
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

    // 1. Add or update routes
    for (const [domainStr, strategy] of Object.entries(expected.routes)) {
      const domain = Number(domainStr);
      const currentStrategy = currentConfig.routes[domain];

      if (!currentStrategy || !feeStrategiesEqual(currentStrategy, strategy)) {
        const { feeData, signers } = feeStrategyToOnChain(strategy);
        txs.push({
          feePayer: ownerAddress,
          instructions: [
            await getSetRemoteFeeRouteInstruction(
              programId,
              feeAccountPda,
              ownerAddress,
              domain,
              null,
              feeData,
              signers,
            ),
          ],
          annotation: `Set route for domain ${domain}`,
        });
      }
    }

    // 2. Remove stale routes
    for (const domain of currentDomains) {
      if (!expectedDomains.has(domain)) {
        txs.push({
          feePayer: ownerAddress,
          instructions: [
            await getRemoveRemoteFeeRouteInstruction(
              programId,
              feeAccountPda,
              ownerAddress,
              domain,
              null,
            ),
          ],
          annotation: `Remove route for domain ${domain}`,
        });
      }
    }

    // 3. Update wildcard signers
    const wildcardSigners = computeWildcardSignersFromStrategies(
      Object.values(expected.routes),
    );
    const currentWildcardSigners = computeWildcardSignersFromStrategies(
      Object.values(currentConfig.routes),
    );
    if (!h160SetEquality(currentWildcardSigners, wildcardSigners)) {
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
