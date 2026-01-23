import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedWarpAddress,
  type RawCollateralWarpArtifactConfig,
  TokenType,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert } from '@hyperlane-xyz/utils';

import type { AnyAleoNetworkClient } from '../clients/base.js';
import type { AleoSigner } from '../clients/signer.js';
import {
  fromAleoAddress,
  generateSuffix,
  getProgramSuffix,
  toAleoAddress,
} from '../utils/helper.js';
import type { AleoReceipt, AnnotatedAleoTransaction } from '../utils/types.js';

import { getCollateralWarpTokenConfig } from './warp-query.js';
import {
  getCreateCollateralTokenTx,
  getEnrollRemoteRouterTx,
  getSetTokenIsmTx,
} from './warp-tx.js';

export class AleoCollateralTokenReader
  implements
    ArtifactReader<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    protected readonly aleoClient: AnyAleoNetworkClient,
    protected readonly ismManager: string,
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
  > {
    // Fetch token config using internal Aleo types
    const token = await getCollateralWarpTokenConfig(
      this.aleoClient,
      address,
      this.ismManager,
    );

    // Convert to provider-sdk artifact format
    const config: RawCollateralWarpArtifactConfig = {
      type: TokenType.collateral,
      owner: token.owner,
      mailbox: token.mailbox,
      interchainSecurityModule: token.ism
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: token.ism,
            },
          }
        : undefined,
      remoteRouters: Object.fromEntries(
        Object.entries(token.remoteRouters).map(([domainId, router]) => [
          domainId,
          { address: router.address },
        ]),
      ),
      destinationGas: Object.fromEntries(
        Object.entries(token.remoteRouters).map(([domainId, router]) => [
          domainId,
          router.gas,
        ]),
      ),
      token: token.token,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: {
        address,
      },
    };
  }
}

export class AleoCollateralTokenWriter
  extends AleoCollateralTokenReader
  implements
    ArtifactWriter<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    aleoClient: AnyAleoNetworkClient,
    private readonly signer: AleoSigner,
    ismManager: string,
  ) {
    super(aleoClient, ismManager);
  }

  async create(
    artifact: ArtifactNew<RawCollateralWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<RawCollateralWarpArtifactConfig, DeployedWarpAddress>,
      AleoReceipt[],
    ]
  > {
    const { config } = artifact;
    const allReceipts: AleoReceipt[] = [];

    // Get mailbox suffix for deployment
    const { programId: mailboxProgramId } = fromAleoAddress(config.mailbox);
    const mailboxSuffix = getProgramSuffix(mailboxProgramId);

    // Generate token suffix (SUFFIX_LENGTH_LONG = 6)
    const tokenSuffix = generateSuffix(6);

    // Deploy collateral token program
    const programs = await this.signer.deployProgram(
      'hyp_collateral',
      mailboxSuffix,
      tokenSuffix,
    );

    const tokenProgramId = programs['hyp_collateral'];
    assert(tokenProgramId, 'hyp_collateral program not deployed');

    // Initialize token
    const initTx = await getCreateCollateralTokenTx(
      this.aleoClient,
      tokenProgramId,
      config.token,
    );
    const initReceipt = await this.signer.sendAndConfirmTransaction(initTx);
    allReceipts.push(initReceipt);

    const tokenAddress = toAleoAddress(tokenProgramId);

    // Set ISM if configured
    if (config.interchainSecurityModule) {
      const setIsmTx = getSetTokenIsmTx(
        tokenAddress,
        config.interchainSecurityModule.deployed.address,
      );

      const ismReceipt = await this.signer.sendAndConfirmTransaction(setIsmTx);
      allReceipts.push(ismReceipt);
    }

    // Enroll remote routers
    for (const [domainIdStr, remoteRouter] of Object.entries(
      config.remoteRouters,
    )) {
      const domainId = parseInt(domainIdStr);
      const gas = config.destinationGas[domainId] || '0';

      const enrollTx = getEnrollRemoteRouterTx(
        tokenAddress,
        domainId,
        remoteRouter.address,
        gas,
      );

      const enrollReceipt =
        await this.signer.sendAndConfirmTransaction(enrollTx);
      allReceipts.push(enrollReceipt);
    }

    // We don't transfer ownership here because after deployment the token needs to be
    // enrolled with the other tokens deployed and only the owner can do that

    const deployedArtifact: ArtifactDeployed<
      RawCollateralWarpArtifactConfig,
      DeployedWarpAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address: tokenAddress,
      },
    };

    return [deployedArtifact, allReceipts];
  }

  async update(
    _artifact: ArtifactDeployed<
      RawCollateralWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedAleoTransaction[]> {
    // TODO: Implement update logic with getWarpTokenUpdateTxs
    // For now, return empty array (no updates)
    return [];
  }
}
