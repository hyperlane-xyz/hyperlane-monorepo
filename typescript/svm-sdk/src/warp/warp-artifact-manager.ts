import { address, type Rpc, type SolanaRpcApi } from '@solana/kit';

import {
  ArtifactState,
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  TokenType,
  type DeployedRawWarpArtifact,
  type DeployedWarpAddress,
  type IRawWarpArtifactManager,
  type RawWarpArtifactConfig,
  type RawWarpArtifactConfigs,
  type WarpType,
} from '@hyperlane-xyz/provider-sdk/warp';
import { ZERO_ADDRESS_HEX_32 } from '@hyperlane-xyz/utils';
import type { SvmSigner } from '../clients/signer.js';
import { fetchMintMetadata } from '../accounts/mint.js';
import {
  decodeCollateralPlugin,
  decodeHyperlaneTokenRouteAccount,
  decodeSyntheticPlugin,
  type HyperlaneTokenAccountData,
} from '../accounts/token.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import {
  SvmCollateralTokenReader,
  SvmCollateralTokenWriter,
} from './collateral-token.js';
import {
  SvmCrossCollateralTokenReader,
  SvmCrossCollateralTokenWriter,
} from './cross-collateral-token.js';
import {
  SvmFactoryCollateralTokenWriter,
  SvmFactoryNativeTokenWriter,
  SvmFactorySyntheticTokenWriter,
} from './factory-token.js';
import { SvmNativeTokenReader, SvmNativeTokenWriter } from './native-token.js';
import {
  SvmSyntheticTokenReader,
  SvmSyntheticTokenWriter,
} from './synthetic-token.js';
import {
  SvmWarpTokenType,
  detectWarpTokenType,
  routerBytesToHex,
} from './warp-query.js';

export interface SvmFactoryAddresses {
  syntheticFactoryProgramId?: string;
  collateralFactoryProgramId?: string;
  nativeFactoryProgramId?: string;
}

export class SvmWarpArtifactManager implements IRawWarpArtifactManager {
  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    private readonly ataPayerFundingAmount: bigint = 100_000_000n,
    private readonly factoryAddresses?: SvmFactoryAddresses,
  ) {}

  async readWarpToken(tokenAddress: string): Promise<DeployedRawWarpArtifact> {
    const tokenAddr = address(tokenAddress);

    // Factory route: the account is owned by the factory program.
    // The route account layout is: initialized(1) | salt(32) | HyperlaneToken
    if (this.factoryAddresses) {
      const acctInfo = await this.rpc
        .getAccountInfo(tokenAddr, { encoding: 'base64' })
        .send();
      if (acctInfo.value && !acctInfo.value.executable) {
        const owner = acctInfo.value.owner as string;
        const {
          syntheticFactoryProgramId: sf,
          collateralFactoryProgramId: cf,
          nativeFactoryProgramId: nf,
        } = this.factoryAddresses;

        let tokenType: SvmWarpTokenType | undefined;
        if (sf && owner === sf) tokenType = SvmWarpTokenType.Synthetic;
        else if (cf && owner === cf) tokenType = SvmWarpTokenType.Collateral;
        else if (nf && owner === nf) tokenType = SvmWarpTokenType.Native;

        if (tokenType !== undefined) {
          const raw = Buffer.from(acctInfo.value.data[0] as string, 'base64');
          const routeData = decodeHyperlaneTokenRouteAccount(raw);
          return await this.buildFactoryRouteArtifact(
            tokenAddress,
            routeData?.token ?? null,
            tokenType,
          );
        }
      }
    }

    // Legacy: derive type-specific PDAs from program ID.
    const tokenType = await detectWarpTokenType(this.rpc, tokenAddr);
    const reader = this.createReader(tokenType);
    return reader.read(tokenAddress);
  }

  private async buildFactoryRouteArtifact(
    tokenAddress: string,
    tokenData: HyperlaneTokenAccountData | null,
    type: SvmWarpTokenType,
  ): Promise<DeployedRawWarpArtifact> {
    const remoteRouters: Record<number, { address: string }> = {};
    const destinationGas: Record<number, string> = {};

    if (tokenData) {
      for (const [domain, router] of tokenData.remoteRouters.entries()) {
        remoteRouters[domain] = { address: routerBytesToHex(router) };
      }
      for (const [domain, gas] of tokenData.destinationGas.entries()) {
        destinationGas[domain] = gas.toString();
      }
    }

    const baseConfig = {
      owner: tokenData?.owner ?? ZERO_ADDRESS_HEX_32,
      mailbox: tokenData?.mailbox ?? '',
      interchainSecurityModule: tokenData?.interchainSecurityModule
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: tokenData.interchainSecurityModule },
          }
        : undefined,
      hook: tokenData?.interchainGasPaymaster
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: tokenData.interchainGasPaymaster.programId },
          }
        : undefined,
      remoteRouters,
      destinationGas,
    };

    let config: RawWarpArtifactConfig;
    if (type === SvmWarpTokenType.Native) {
      config = {
        ...baseConfig,
        type: TokenType.native,
        decimals: tokenData?.decimals ?? 9,
      };
    } else if (type === SvmWarpTokenType.Synthetic) {
      let name = '';
      let symbol = '';
      let decimals = tokenData?.decimals ?? 0;
      if (tokenData?.pluginData.length) {
        const { mint } = decodeSyntheticPlugin(tokenData.pluginData);
        const meta = await fetchMintMetadata(this.rpc, mint.toString());
        name = meta.name;
        symbol = meta.symbol;
        decimals = meta.decimals;
      }
      config = {
        ...baseConfig,
        type: TokenType.synthetic,
        name,
        symbol,
        decimals,
      };
    } else {
      const token = tokenData
        ? decodeCollateralPlugin(tokenData.pluginData).mint
        : '';
      config = { ...baseConfig, type: TokenType.collateral, token };
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: { address: tokenAddress },
    };
  }

  createReader<T extends WarpType>(
    type: T,
  ): ArtifactReader<RawWarpArtifactConfigs[T], DeployedWarpAddress> {
    const readers: {
      [K in WarpType]: () => ArtifactReader<
        RawWarpArtifactConfigs[K],
        DeployedWarpAddress
      >;
    } = {
      native: () => new SvmNativeTokenReader(this.rpc),
      synthetic: () => new SvmSyntheticTokenReader(this.rpc),
      collateral: () => new SvmCollateralTokenReader(this.rpc),
      crossCollateral: () => new SvmCrossCollateralTokenReader(this.rpc),
    };

    return readers[type]();
  }

  createWriter<T extends WarpType>(
    type: T,
    signer: SvmSigner,
  ): ArtifactWriter<RawWarpArtifactConfigs[T], DeployedWarpAddress> {
    const syntheticFactory = this.factoryAddresses?.syntheticFactoryProgramId;
    const collateralFactory = this.factoryAddresses?.collateralFactoryProgramId;
    const nativeFactory = this.factoryAddresses?.nativeFactoryProgramId;

    const writers: {
      [K in WarpType]: () => ArtifactWriter<
        RawWarpArtifactConfigs[K],
        DeployedWarpAddress
      >;
    } = {
      native: () =>
        nativeFactory
          ? new SvmFactoryNativeTokenWriter(
              this.rpc,
              signer,
              address(nativeFactory),
            )
          : new SvmNativeTokenWriter(
              {
                program: {
                  programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenNative,
                },
                ataPayerFundingAmount: this.ataPayerFundingAmount,
              },
              this.rpc,
              signer,
            ),
      synthetic: () =>
        syntheticFactory
          ? new SvmFactorySyntheticTokenWriter(
              this.rpc,
              signer,
              address(syntheticFactory),
              this.ataPayerFundingAmount,
            )
          : new SvmSyntheticTokenWriter(
              {
                program: {
                  programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenSynthetic,
                },
                ataPayerFundingAmount: this.ataPayerFundingAmount,
              },
              this.rpc,
              signer,
            ),
      collateral: () =>
        collateralFactory
          ? new SvmFactoryCollateralTokenWriter(
              this.rpc,
              signer,
              address(collateralFactory),
              this.ataPayerFundingAmount,
            )
          : new SvmCollateralTokenWriter(
              {
                program: {
                  programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenCollateral,
                },
                ataPayerFundingAmount: this.ataPayerFundingAmount,
              },
              this.rpc,
              signer,
            ),
      crossCollateral: () =>
        new SvmCrossCollateralTokenWriter(
          {
            program: {
              programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenCrossCollateral,
            },
            ataPayerFundingAmount: this.ataPayerFundingAmount,
          },
          this.rpc,
          signer,
        ),
    };

    return writers[type]();
  }

  supportsHookUpdates(): boolean {
    return true;
  }
}
