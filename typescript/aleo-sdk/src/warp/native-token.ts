import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedWarpAddress,
  type RawNativeWarpArtifactConfig,
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
  type OnChainArtifactManagers,
  aleoWarpFieldsToArtifactApi,
} from '../utils/types.js';

import { getNativeWarpTokenConfig } from './warp-query.js';
import {
  getCreateNativeTokenTx,
  getPostDeploymentUpdateTxs,
  getWarpTokenUpdateTxs,
} from './warp-tx.js';

export class AleoNativeTokenReader
  implements ArtifactReader<RawNativeWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    protected readonly aleoClient: AnyAleoNetworkClient,
    protected readonly onChainArtifactManagers: OnChainArtifactManagers,
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawNativeWarpArtifactConfig, DeployedWarpAddress>
  > {
    // Fetch token config using internal Aleo types
    const token = await getNativeWarpTokenConfig(
      this.aleoClient,
      address,
      this.onChainArtifactManagers.ismManagerAddress,
      this.onChainArtifactManagers.hookManagerAddress,
    );

    // Convert to provider-sdk artifact format
    const { destinationGas, remoteRouters, interchainSecurityModule, hook } =
      aleoWarpFieldsToArtifactApi(token);
    const config: RawNativeWarpArtifactConfig = {
      type: TokenType.native,
      owner: token.owner,
      mailbox: token.mailbox,
      destinationGas,
      remoteRouters,
      interchainSecurityModule,
      hook,
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

export class AleoNativeTokenWriter
  extends AleoNativeTokenReader
  implements ArtifactWriter<RawNativeWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    aleoClient: AnyAleoNetworkClient,
    private readonly signer: AleoSigner,
    onChainArtifactManagers: OnChainArtifactManagers,
  ) {
    super(aleoClient, onChainArtifactManagers);
  }

  async create(
    artifact: ArtifactNew<RawNativeWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<RawNativeWarpArtifactConfig, DeployedWarpAddress>,
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

    // Deploy native token program
    const programs = await this.signer.deployProgram(
      'hyp_native',
      mailboxSuffix,
      tokenSuffix,
    );

    const tokenProgramId = programs['hyp_native'];
    assert(
      tokenProgramId,
      'Expected native token program to be deployed but none was found in deployment mapping',
    );

    // Initialize token
    const initTx = getCreateNativeTokenTx(tokenProgramId);
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
      RawNativeWarpArtifactConfig,
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
      RawNativeWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedAleoTransaction[]> {
    // Read current state from chain
    const currentArtifact = await this.read(artifact.deployed.address);

    // Generate update transactions
    return getWarpTokenUpdateTxs(artifact, currentArtifact);
  }
}
