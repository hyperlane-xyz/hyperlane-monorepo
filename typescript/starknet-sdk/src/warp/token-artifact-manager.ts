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
  return 'synthetic';
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

  protected abstract createToken(artifact: ArtifactNew<C>): Promise<string>;

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
    const tokenAddress = await this.createToken(artifact);
    receipts.push(
      ...(await this.applyPostCreateConfig(tokenAddress, artifact.config, {
        owner: this.signer.getSignerAddress(),
        interchainSecurityModule: undefined,
        hook: undefined,
        remoteRouters: {},
        destinationGas: {},
      })),
    );

    return [await this.read(tokenAddress), receipts];
  }

  async update(
    artifact: ArtifactDeployed<C, DeployedWarpAddress>,
  ): Promise<AnnotatedTx[]> {
    const current = await this.read(artifact.deployed.address);
    this.validateUpdateConfig(current.config, artifact.config);
    this.assertNoOrphanDestinationGas(artifact.config);

    const txs: AnnotatedTx[] = [];
    const tokenAddress = artifact.deployed.address;
    let ownerTx: AnnotatedTx | undefined;

    const currentOwner = current.config.owner;
    if (!eqAddressStarknet(currentOwner, artifact.config.owner)) {
      ownerTx = {
        annotation: 'Setting warp token owner',
        ...(await this.signer.getSetTokenOwnerTransaction({
          signer: this.signer.getSignerAddress(),
          tokenAddress,
          newOwner: artifact.config.owner,
        })),
      };
    }

    const currentIsm = artifactOnChainToAddress(
      current.config.interchainSecurityModule,
      normalizeStarknetAddressSafe,
    );
    const expectedIsm = artifactOnChainToAddress(
      artifact.config.interchainSecurityModule,
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
      artifact.config.hook,
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

    const domains = new Set<number>([
      ...Object.keys(current.config.remoteRouters).map(Number),
      ...Object.keys(artifact.config.remoteRouters).map(Number),
      ...Object.keys(current.config.destinationGas).map(Number),
      ...Object.keys(artifact.config.destinationGas).map(Number),
    ]);

    for (const domain of [...domains].sort((a, b) => a - b)) {
      const currentRouter = current.config.remoteRouters[domain];
      const expectedRouter = artifact.config.remoteRouters[domain];
      const currentGas = normalizeGas(current.config.destinationGas[domain]);
      const expectedGas = normalizeGas(artifact.config.destinationGas[domain]);

      if (!expectedRouter) {
        if (currentRouter) {
          txs.push({
            annotation: `Unenrolling remote router for domain ${domain}`,
            ...(await this.signer.getUnenrollRemoteRouterTransaction({
              signer: this.signer.getSignerAddress(),
              tokenAddress,
              receiverDomainId: domain,
            })),
          });
        }
        continue;
      }

      const routerChanged =
        !currentRouter ||
        !eqAddressStarknet(currentRouter.address, expectedRouter.address);
      const gasChanged = !currentRouter || currentGas !== expectedGas;
      if (routerChanged || gasChanged) {
        txs.push({
          annotation: `Enrolling remote router for domain ${domain}`,
          ...(await this.signer.getEnrollRemoteRouterTransaction({
            signer: this.signer.getSignerAddress(),
            tokenAddress,
            remoteRouter: {
              receiverDomainId: domain,
              receiverAddress: expectedRouter.address,
              gas: expectedGas,
            },
          })),
        });
      }
    }

    if (ownerTx) {
      txs.push(ownerTx);
    }

    return txs;
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
    let ownerTx: AnnotatedTx | undefined;

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
