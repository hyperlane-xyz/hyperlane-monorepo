import {
  type Artifact,
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactOnChain,
  ArtifactComposition,
  ArtifactState,
  type ConfigOnChain,
  type OrchestratedArtifactReader,
  type OrchestratedArtifactWriter,
  type WithCompositionVariant,
  addressToUnderivedArtifact,
  artifactOnChainToAddress,
  isArtifactDeployed,
  isArtifactUnderived,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import {
  TokenType,
  computeRemoteRoutersUpdates,
  type DeployedWarpAddress,
  type RawWarpArtifactConfig,
  type WarpArtifactConfigs,
  type WarpType,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  ZERO_ADDRESS_HEX_32,
  assert,
  eqAddressStarknet,
  isEmptyAddress,
} from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
import { normalizeStarknetAddressSafe } from '../contracts.js';
import { type StarknetAnnotatedTx, type StarknetTxReceipt } from '../types.js';
import {
  getEnrollRemoteRouterTx,
  getSetTokenHookTx,
  getSetTokenIsmTx,
  getSetTokenOwnerTx,
  getUnenrollRemoteRouterTx,
} from './warp-tx.js';

export type StarknetWarpTokenOnChain = Awaited<
  ReturnType<StarknetProvider['getToken']>
>;
export type StarknetRemoteRoutersOnChain = Awaited<
  ReturnType<StarknetProvider['getRemoteRouters']>
>;

function normalizeGas(gas: string | undefined): string {
  return BigInt(gas ?? '0').toString();
}

/**
 * Narrows an `Artifact<>` child to its on-chain variant. Returns undefined
 * when the input is undefined; throws when the input is in a pre-deploy
 * state (NEW or EMBEDDED) — the deploy-sdk must resolve children before
 * invoking the raw writer.
 */
function toOnChainOrUndefined<C, D extends { address: string }>(
  child: Artifact<C, D> | undefined,
): ArtifactOnChain<C, D> | undefined {
  if (!child) return undefined;
  assert(
    isArtifactDeployed(child) || isArtifactUnderived(child),
    `Starknet warp writer: nested child must be resolved on-chain (DEPLOYED or UNDERIVED); got artifactState=${child.artifactState ?? 'new'}`,
  );
  return child;
}

export function getStarknetWarpType(tokenType: string): WarpType {
  if (tokenType === TokenType.native) return 'native';
  if (tokenType === TokenType.collateral) return 'collateral';
  if (tokenType === TokenType.synthetic) return 'synthetic';
  if (tokenType === TokenType.crossCollateral) return 'crossCollateral';
  throw new Error(`Unsupported Starknet warp token type: ${tokenType}`);
}

export abstract class StarknetWarpTokenReaderBase<
  T extends WarpType,
  C extends WarpArtifactConfigs[T],
> implements OrchestratedArtifactReader<C, DeployedWarpAddress> {
  readonly composition = ArtifactComposition.ORCHESTRATED;

  constructor(protected readonly provider: StarknetProvider) {}

  protected abstract readonly tokenType: T;

  protected abstract toConfig(
    token: StarknetWarpTokenOnChain,
    remoteRouters: StarknetRemoteRoutersOnChain,
  ): WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>;

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      ConfigOnChain<
        WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
        DeployedWarpAddress
      >,
      DeployedWarpAddress
    >
  > {
    const token = await this.provider.getToken({ tokenAddress: address });
    const remoteRouters = await this.provider.getRemoteRouters({
      tokenAddress: address,
    });

    const actualType = getStarknetWarpType(token.tokenType);
    assert(
      actualType === this.tokenType,
      `Expected Starknet warp token ${address} to be ${this.tokenType}, got ${actualType}`,
    );

    return {
      artifactState: ArtifactState.DEPLOYED,
      // CAST: `toConfig` returns the pre-collapse variant with
      // `ArtifactUnderived` children (already on-chain). `ConfigOnChain`
      // is structurally identical here — TS can't reduce the generic
      // mapped type at indexing time.
      config: this.toConfig(token, remoteRouters) as ConfigOnChain<
        WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
        DeployedWarpAddress
      >,
      deployed: { address: normalizeStarknetAddressSafe(token.address) },
    };
  }

  protected baseConfig(
    token: StarknetWarpTokenOnChain,
    remoteRouters: StarknetRemoteRoutersOnChain,
  ) {
    const routers: Record<number, { address: string }> = {};
    const destinationGas: Record<number, string> = {};

    for (const remoteRouter of remoteRouters.remoteRouters) {
      routers[remoteRouter.receiverDomainId] = {
        address: normalizeStarknetAddressSafe(remoteRouter.receiverAddress),
      };
      destinationGas[remoteRouter.receiverDomainId] = normalizeGas(
        remoteRouter.gas,
      );
    }

    return {
      owner: normalizeStarknetAddressSafe(token.owner),
      mailbox: normalizeStarknetAddressSafe(token.mailboxAddress),
      interchainSecurityModule: addressToUnderivedArtifact(
        token.ismAddress,
        normalizeStarknetAddressSafe,
      ),
      hook: addressToUnderivedArtifact(
        token.hookAddress,
        normalizeStarknetAddressSafe,
      ),
      remoteRouters: routers,
      destinationGas,
    };
  }
}

export abstract class StarknetWarpTokenWriterBase<
  T extends WarpType,
  C extends WarpArtifactConfigs[T],
>
  extends StarknetWarpTokenReaderBase<T, C>
  implements OrchestratedArtifactWriter<C, DeployedWarpAddress>
{
  constructor(
    provider: StarknetProvider,
    protected readonly signer: StarknetSigner,
  ) {
    super(provider);
  }

  protected abstract createToken(
    artifact: ArtifactNew<
      WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>
    >,
  ): Promise<StarknetTxReceipt>;

  protected validateCreateConfig(
    config: WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
  ): void {
    assert(!config.scale, 'scale is unsupported for Starknet warp tokens');
  }

  protected validateUpdateConfig(
    current: WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
    expected: WithCompositionVariant<
      C,
      typeof ArtifactComposition.ORCHESTRATED
    >,
  ): void {
    assert(!expected.scale, 'scale is unsupported for Starknet warp tokens');
    assert(
      eqAddressStarknet(current.mailbox, expected.mailbox),
      `Cannot change Starknet warp token mailbox from ${current.mailbox} to ${expected.mailbox}`,
    );
  }

  async create(
    artifact: ArtifactNew<
      WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>
    >,
  ): Promise<
    [
      ArtifactDeployed<
        ConfigOnChain<
          WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
          DeployedWarpAddress
        >,
        DeployedWarpAddress
      >,
      TxReceipt[],
    ]
  > {
    this.validateCreateConfig(artifact.config);
    this.assertNoOrphanDestinationGas(artifact.config);

    const receipts: TxReceipt[] = [];
    const createReceipt = await this.createToken(artifact);
    receipts.push(createReceipt);
    assert(
      createReceipt.contractAddress,
      'failed to deploy Starknet warp token',
    );
    const tokenAddress = createReceipt.contractAddress;
    receipts.push(
      ...(await this.applyPostCreateConfig(tokenAddress, artifact.config, {
        owner: this.signer.getSignerAddress(),
        interchainSecurityModule: undefined,
        hook: undefined,
        remoteRouters: {},
        destinationGas: {},
      })),
    );

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        // CAST: ISM/hook children passed into create are expected to be
        // resolved (DEPLOYED / UNDERIVED). `ConfigOnChain<X, _>` is
        // structurally identical to `X` here — TS can't reduce the
        // generic mapped type at indexing time.
        config: artifact.config as ConfigOnChain<
          WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
          DeployedWarpAddress
        >,
        deployed: { address: normalizeStarknetAddressSafe(tokenAddress) },
      },
      receipts,
    ];
  }

  async update(
    artifact: ArtifactDeployed<
      WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedTx[]> {
    const current = await this.read(artifact.deployed.address);
    // CAST: read() returns post-collapse via ConfigOnChain; helper methods
    // below treat the on-chain config as the pre-collapse variant with
    // resolved children. They're structurally identical at runtime.
    const currentConfig = current.config as WithCompositionVariant<
      C,
      typeof ArtifactComposition.ORCHESTRATED
    >;
    const expectedConfig = this.preserveUnsetHookAndIsm(
      currentConfig,
      artifact.config,
    );
    this.validateUpdateConfig(currentConfig, expectedConfig);
    this.assertNoOrphanDestinationGas(expectedConfig);

    const txs: AnnotatedTx[] = [];
    const tokenAddress = artifact.deployed.address;
    let ownerTx: StarknetAnnotatedTx | undefined;

    const currentOwner = currentConfig.owner;
    if (!eqAddressStarknet(currentOwner, expectedConfig.owner)) {
      ownerTx = {
        annotation: 'Setting warp token owner',
        ...(await getSetTokenOwnerTx(this.provider.getRawProvider(), {
          tokenAddress,
          newOwner: expectedConfig.owner,
        })),
      };
    }

    const currentIsm = artifactOnChainToAddress(
      toOnChainOrUndefined(currentConfig.interchainSecurityModule),
      normalizeStarknetAddressSafe,
    );
    const expectedIsm = artifactOnChainToAddress(
      toOnChainOrUndefined(expectedConfig.interchainSecurityModule),
      normalizeStarknetAddressSafe,
    );
    if (
      !eqAddressStarknet(
        currentIsm ?? ZERO_ADDRESS_HEX_32,
        expectedIsm ?? ZERO_ADDRESS_HEX_32,
      )
    ) {
      txs.push({
        annotation: 'Setting warp token ISM',
        ...(await getSetTokenIsmTx(this.provider.getRawProvider(), {
          tokenAddress,
          ismAddress: expectedIsm,
        })),
      });
    }

    const currentHook = artifactOnChainToAddress(
      toOnChainOrUndefined(currentConfig.hook),
      normalizeStarknetAddressSafe,
    );
    const expectedHook = artifactOnChainToAddress(
      toOnChainOrUndefined(expectedConfig.hook),
      normalizeStarknetAddressSafe,
    );
    if (
      !eqAddressStarknet(
        currentHook ?? ZERO_ADDRESS_HEX_32,
        expectedHook ?? ZERO_ADDRESS_HEX_32,
      )
    ) {
      txs.push({
        annotation: 'Setting warp token hook',
        ...(await getSetTokenHookTx(this.provider.getRawProvider(), {
          tokenAddress,
          hookAddress: expectedHook,
        })),
      });
    }

    const routerUpdates = computeRemoteRoutersUpdates(
      {
        remoteRouters: currentConfig.remoteRouters,
        destinationGas: currentConfig.destinationGas,
      },
      {
        remoteRouters: expectedConfig.remoteRouters,
        destinationGas: expectedConfig.destinationGas,
      },
      eqAddressStarknet,
    );

    for (const domain of routerUpdates.toUnenroll.sort((a, b) => a - b)) {
      txs.push({
        annotation: `Unenrolling remote router for domain ${domain}`,
        ...(await getUnenrollRemoteRouterTx(this.provider.getRawProvider(), {
          tokenAddress,
          receiverDomainId: domain,
        })),
      });
    }

    for (const route of routerUpdates.toEnroll.sort(
      (a, b) => a.domainId - b.domainId,
    )) {
      txs.push({
        annotation: `Enrolling remote router for domain ${route.domainId}`,
        ...(await getEnrollRemoteRouterTx(this.provider.getRawProvider(), {
          tokenAddress,
          remoteRouter: {
            receiverDomainId: route.domainId,
            receiverAddress: route.routerAddress,
            gas: normalizeGas(route.gas),
          },
        })),
      });
    }

    if (ownerTx) {
      txs.push(ownerTx);
    }

    return txs;
  }

  private preserveUnsetHookAndIsm(
    current: WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
    expected: WithCompositionVariant<
      C,
      typeof ArtifactComposition.ORCHESTRATED
    >,
  ): WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED> {
    const expectedIsm = artifactOnChainToAddress(
      toOnChainOrUndefined(expected.interchainSecurityModule),
      normalizeStarknetAddressSafe,
    );
    const expectedHook = artifactOnChainToAddress(
      toOnChainOrUndefined(expected.hook),
      normalizeStarknetAddressSafe,
    );

    return {
      ...expected,
      interchainSecurityModule: isEmptyAddress(expectedIsm)
        ? addressToUnderivedArtifact(
            artifactOnChainToAddress(
              toOnChainOrUndefined(current.interchainSecurityModule),
              normalizeStarknetAddressSafe,
            ),
          )
        : expected.interchainSecurityModule,
      hook: isEmptyAddress(expectedHook)
        ? addressToUnderivedArtifact(
            artifactOnChainToAddress(
              toOnChainOrUndefined(current.hook),
              normalizeStarknetAddressSafe,
            ),
          )
        : expected.hook,
    };
  }

  private assertNoOrphanDestinationGas(
    config: WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
  ): void {
    for (const domain of Object.keys(config.destinationGas)) {
      assert(
        config.remoteRouters[Number(domain)],
        `destinationGas for domain ${domain} requires a matching remote router on Starknet`,
      );
    }
  }

  private async applyPostCreateConfig(
    tokenAddress: string,
    expected: WithCompositionVariant<
      C,
      typeof ArtifactComposition.ORCHESTRATED
    >,
    current: Pick<
      RawWarpArtifactConfig,
      | 'owner'
      | 'interchainSecurityModule'
      | 'hook'
      | 'remoteRouters'
      | 'destinationGas'
    >,
  ): Promise<TxReceipt[]> {
    const receipts: TxReceipt[] = [];
    let ownerTx: StarknetAnnotatedTx | undefined;

    const expectedIsm = artifactOnChainToAddress(
      toOnChainOrUndefined(expected.interchainSecurityModule),
      normalizeStarknetAddressSafe,
    );
    if (expectedIsm) {
      const tx = await getSetTokenIsmTx(this.provider.getRawProvider(), {
        tokenAddress,
        ismAddress: expectedIsm,
      });
      receipts.push(await this.signer.sendAndConfirmTransaction(tx));
    }

    const expectedHook = artifactOnChainToAddress(
      toOnChainOrUndefined(expected.hook),
      normalizeStarknetAddressSafe,
    );
    if (expectedHook) {
      const tx = await getSetTokenHookTx(this.provider.getRawProvider(), {
        tokenAddress,
        hookAddress: expectedHook,
      });
      receipts.push(await this.signer.sendAndConfirmTransaction(tx));
    }

    for (const domain of Object.keys(expected.remoteRouters)
      .map(Number)
      .sort((a, b) => a - b)) {
      const remoteRouter = expected.remoteRouters[domain];
      assert(
        remoteRouter,
        `Missing remote router for Starknet domain ${domain}`,
      );
      const tx = await getEnrollRemoteRouterTx(this.provider.getRawProvider(), {
        tokenAddress,
        remoteRouter: {
          receiverDomainId: domain,
          receiverAddress: remoteRouter.address,
          gas: normalizeGas(expected.destinationGas[domain]),
        },
      });
      receipts.push(await this.signer.sendAndConfirmTransaction(tx));
    }

    const currentOwner = current.owner;
    if (!eqAddressStarknet(currentOwner, expected.owner)) {
      ownerTx = await getSetTokenOwnerTx(this.provider.getRawProvider(), {
        tokenAddress,
        newOwner: expected.owner,
      });
    }

    if (ownerTx) {
      receipts.push(await this.signer.sendAndConfirmTransaction(ownerTx));
    }

    return receipts;
  }
}
