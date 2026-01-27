import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedWarpAddress,
  type RawSyntheticWarpArtifactConfig,
  TokenType,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert } from '@hyperlane-xyz/utils';

import type { AnyAleoNetworkClient } from '../clients/base.js';
import type { AleoSigner } from '../clients/signer.js';
import {
  SUFFIX_LENGTH_LONG,
  fromAleoAddress,
  generateSuffix,
  getProgramSuffix,
  toAleoAddress,
} from '../utils/helper.js';
import {
  type AleoReceipt,
  type AnnotatedAleoTransaction,
  aleoWarpFieldsToArtifactApi,
} from '../utils/types.js';

import { getSyntheticWarpTokenConfig } from './warp-query.js';
import {
  getCreateSyntheticTokenTx,
  getPostDeploymentUpdateTxs,
  getWarpTokenUpdateTxs,
} from './warp-tx.js';

export class AleoSyntheticTokenReader
  implements ArtifactReader<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    protected readonly aleoClient: AnyAleoNetworkClient,
    protected readonly ismManager: string,
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
  > {
    // Fetch token config using internal Aleo types
    const token = await getSyntheticWarpTokenConfig(
      this.aleoClient,
      address,
      this.ismManager,
    );

    // Convert to provider-sdk artifact format
    const { destinationGas, remoteRouters, interchainSecurityModule } =
      aleoWarpFieldsToArtifactApi(token);
    const config: RawSyntheticWarpArtifactConfig = {
      type: TokenType.synthetic,
      owner: token.owner,
      mailbox: token.mailbox,
      destinationGas,
      remoteRouters,
      interchainSecurityModule,
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

export class AleoSyntheticTokenWriter
  extends AleoSyntheticTokenReader
  implements ArtifactWriter<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    aleoClient: AnyAleoNetworkClient,
    private readonly signer: AleoSigner,
    ismManager: string,
  ) {
    super(aleoClient, ismManager);
  }

  async create(
    artifact: ArtifactNew<RawSyntheticWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>,
      AleoReceipt[],
    ]
  > {
    const { config } = artifact;
    const allReceipts: AleoReceipt[] = [];

    // Get mailbox suffix for deployment
    const { programId: mailboxProgramId } = fromAleoAddress(config.mailbox);
    const mailboxSuffix = getProgramSuffix(mailboxProgramId);

    // Generate token suffix
    const tokenSuffix = generateSuffix(SUFFIX_LENGTH_LONG);

    // Deploy synthetic token program
    const programs = await this.signer.deployProgram(
      'hyp_synthetic',
      mailboxSuffix,
      tokenSuffix,
    );

    const tokenProgramId = programs['hyp_synthetic'];
    assert(
      tokenProgramId,
      'Expected synthetic token program to be deployed but none was found in deployment mapping',
    );

    // Initialize token
    const initTx = getCreateSyntheticTokenTx(
      tokenProgramId,
      config.name,
      config.symbol,
      config.decimals,
    );
    const initReceipt = await this.signer.sendAndConfirmTransaction(initTx);
    allReceipts.push(initReceipt);

    const tokenAddress = toAleoAddress(tokenProgramId);

    // Perform post-deployment updates (ISM setup and router enrollment)
    const postDeploymentTxs = getPostDeploymentUpdateTxs(tokenAddress, config);

    for (const tx of postDeploymentTxs) {
      const receipt = await this.signer.sendAndConfirmTransaction(tx);
      allReceipts.push(receipt);
    }

    const deployedArtifact: ArtifactDeployed<
      RawSyntheticWarpArtifactConfig,
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
    artifact: ArtifactDeployed<
      RawSyntheticWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedAleoTransaction[]> {
    // Read current state from chain
    const currentArtifact = await this.read(artifact.deployed.address);

    // Generate update transactions
    return getWarpTokenUpdateTxs(artifact, currentArtifact);
  }
}
