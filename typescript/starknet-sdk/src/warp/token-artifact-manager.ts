import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
  addressToUnderivedArtifact,
  artifactOnChainToAddress,
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
  type RawWarpArtifactConfigs,
  type WarpType,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  ZERO_ADDRESS_HEX_32,
  assert,
  eqAddressStarknet,
} from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
import { normalizeStarknetAddressSafe } from '../contracts.js';
import { type StarknetAnnotatedTx, type StarknetTxReceipt } from '../types.js';

export type StarknetWarpTokenOnChain = Awaited<
  ReturnType<StarknetProvider['getToken']>
>;
export type StarknetRemoteRoutersOnChain = Awaited<
  ReturnType<StarknetProvider['getRemoteRouters']>
>;

function normalizeGas(gas: string | undefined): string {
  return BigInt(gas ?? '0').toString();
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
  C extends RawWarpArtifactConfigs[T],
> implements ArtifactReader<C, DeployedWarpAddress> {
  constructor(protected readonly provider: StarknetProvider) {}

  protected abstract readonly tokenType: T;

  protected abstract toConfig(
    token: StarknetWarpTokenOnChain,
    remoteRouters: StarknetRemoteRoutersOnChain,
  ): C;

  async read(
    address: string,
  ): Promise<ArtifactDeployed<C, DeployedWarpAddress>> {
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
      config: this.toConfig(token, remoteRouters),
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
  C extends RawWarpArtifactConfigs[T],
>
  extends StarknetWarpTokenReaderBase<T, C>
  implements ArtifactWriter<C, DeployedWarpAddress>
{
  constructor(
    provider: StarknetProvider,
    protected readonly signer: StarknetSigner,
  ) {
    super(provider);
  }

  protected abstract createToken(
    artifact: ArtifactNew<C>,
  ): Promise<StarknetTxReceipt>;

  protected validateCreateConfig(config: C): void {
    assert(!config.scale, 'scale is unsupported for Starknet warp tokens');
  }

  protected validateUpdateConfig(current: C, expected: C): void {
    assert(!expected.scale, 'scale is unsupported for Starknet warp tokens');
    assert(
      eqAddressStarknet(current.mailbox, expected.mailbox),
      `Cannot change Starknet warp token mailbox from ${current.mailbox} to ${expected.mailbox}`,
    );
  }

  async create(
    artifact: ArtifactNew<C>,
  ): Promise<[ArtifactDeployed<C, DeployedWarpAddress>, TxReceipt[]]> {
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
        config: artifact.config,
        deployed: { address: normalizeStarknetAddressSafe(tokenAddress) },
      },
      receipts,
    ];
  }

  async update(
    artifact: ArtifactDeployed<C, DeployedWarpAddress>,
  ): Promise<AnnotatedTx[]> {
    const current = await this.read(artifact.deployed.address);
    const expectedConfig = this.preserveUnsetHookAndIsm(
      current.config,
      artifact.config,
    );
    this.validateUpdateConfig(current.config, expectedConfig);
    this.assertNoOrphanDestinationGas(expectedConfig);

    const txs: AnnotatedTx[] = [];
    const tokenAddress = artifact.deployed.address;
    let ownerTx: StarknetAnnotatedTx | undefined;

    const currentOwner = current.config.owner;
    if (!eqAddressStarknet(currentOwner, expectedConfig.owner)) {
      ownerTx = {
        annotation: 'Setting warp token owner',
        ...(await this.signer.getSetTokenOwnerTransaction({
          signer: this.signer.getSignerAddress(),
          tokenAddress,
          newOwner: expectedConfig.owner,
        })),
      };
    }

    const currentIsm = artifactOnChainToAddress(
      current.config.interchainSecurityModule,
      normalizeStarknetAddressSafe,
    );
    const expectedIsm = artifactOnChainToAddress(
      expectedConfig.interchainSecurityModule,
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
        ...(await this.signer.getSetTokenIsmTransaction({
          signer: this.signer.getSignerAddress(),
          tokenAddress,
          ismAddress: expectedIsm,
        })),
      });
    }

    const currentHook = artifactOnChainToAddress(
      current.config.hook,
      normalizeStarknetAddressSafe,
    );
    const expectedHook = artifactOnChainToAddress(
      expectedConfig.hook,
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
        ...(await this.signer.getSetTokenHookTransaction({
          signer: this.signer.getSignerAddress(),
          tokenAddress,
          hookAddress: expectedHook,
        })),
      });
    }

    const routerUpdates = computeRemoteRoutersUpdates(
      {
        remoteRouters: current.config.remoteRouters,
        destinationGas: current.config.destinationGas,
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
        ...(await this.signer.getUnenrollRemoteRouterTransaction({
          signer: this.signer.getSignerAddress(),
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
        ...(await this.signer.getEnrollRemoteRouterTransaction({
          signer: this.signer.getSignerAddress(),
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

  private preserveUnsetHookAndIsm(current: C, expected: C): C {
    return {
      ...expected,
      interchainSecurityModule:
        expected.interchainSecurityModule ??
        addressToUnderivedArtifact(
          artifactOnChainToAddress(
            current.interchainSecurityModule,
            normalizeStarknetAddressSafe,
          ),
        ),
      hook:
        expected.hook ??
        addressToUnderivedArtifact(
          artifactOnChainToAddress(current.hook, normalizeStarknetAddressSafe),
        ),
    };
  }

  private assertNoOrphanDestinationGas(config: C): void {
    for (const domain of Object.keys(config.destinationGas)) {
      assert(
        config.remoteRouters[Number(domain)],
        `destinationGas for domain ${domain} requires a matching remote router on Starknet`,
      );
    }
  }

  private async applyPostCreateConfig(
    tokenAddress: string,
    expected: C,
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
      expected.interchainSecurityModule,
      normalizeStarknetAddressSafe,
    );
    if (expectedIsm) {
      const tx = await this.signer.getSetTokenIsmTransaction({
        signer: this.signer.getSignerAddress(),
        tokenAddress,
        ismAddress: expectedIsm,
      });
      receipts.push(await this.signer.sendAndConfirmTransaction(tx));
    }

    const expectedHook = artifactOnChainToAddress(
      expected.hook,
      normalizeStarknetAddressSafe,
    );
    if (expectedHook) {
      const tx = await this.signer.getSetTokenHookTransaction({
        signer: this.signer.getSignerAddress(),
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
      const tx = await this.signer.getEnrollRemoteRouterTransaction({
        signer: this.signer.getSignerAddress(),
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
      ownerTx = await this.signer.getSetTokenOwnerTransaction({
        signer: this.signer.getSignerAddress(),
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
