import {
  type ArtifactDeployed,
  type ArtifactNew,
  ArtifactComposition,
  ArtifactState,
  type WithCompositionVariant,
  type ArtifactReader,
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
  fromAleoAddress,
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

type OrchestratedRawNativeWarpArtifactConfig = WithCompositionVariant<
  RawNativeWarpArtifactConfig,
  typeof ArtifactComposition.ORCHESTRATED
>;

function withErrorContext(context: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${context}: ${message}`);
}

export class AleoNativeTokenReader implements ArtifactReader<
  RawNativeWarpArtifactConfig,
  DeployedWarpAddress
> {
  readonly composition = ArtifactComposition.ORCHESTRATED;

  constructor(
    protected readonly aleoClient: AnyAleoNetworkClient,
    protected readonly onChainArtifactManagers: OnChainArtifactManagers,
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      OrchestratedRawNativeWarpArtifactConfig,
      DeployedWarpAddress
    >
  > {
    // Fetch token config using internal Aleo types
    const token = await getNativeWarpTokenConfig(
      this.aleoClient,
      address,
      this.onChainArtifactManagers.ismManagerAddress,
      this.onChainArtifactManagers.hookManagerAddress,
    ).catch((error: unknown) => {
      throw withErrorContext(
        `Failed to read native warp token ${address} (ismManager=${this.onChainArtifactManagers.ismManagerAddress}, hookManager=${this.onChainArtifactManagers.hookManagerAddress})`,
        error,
      );
    });

    // Convert to provider-sdk artifact format
    const { destinationGas, remoteRouters, interchainSecurityModule, hook } =
      aleoWarpFieldsToArtifactApi(token);
    const config: OrchestratedRawNativeWarpArtifactConfig = {
      composition: ArtifactComposition.ORCHESTRATED,
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
    artifact: ArtifactNew<OrchestratedRawNativeWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<
        OrchestratedRawNativeWarpArtifactConfig,
        DeployedWarpAddress
      >,
      AleoReceipt[],
    ]
  > {
    const { config } = artifact;
    const allReceipts: AleoReceipt[] = [];
    const signerAddress = this.signer.getSignerAddress();

    // Get mailbox suffix for deployment
    const { programId: mailboxProgramId } = fromAleoAddress(config.mailbox);
    const mailboxSuffix = getProgramSuffix(mailboxProgramId);

    // Resolve token suffix from preferred setting or generate a collision-free one
    const tokenSuffix = await this.signer.getWarpTokenSuffix('native');

    // Deploy native token program
    const programs = await this.signer
      .deployProgram('hyp_native', mailboxSuffix, tokenSuffix)
      .catch((error: unknown) => {
        throw withErrorContext(
          `Failed to deployProgram(hyp_native) for mailbox ${config.mailbox} (signer=${signerAddress})`,
          error,
        );
      });

    const tokenProgramId = programs['hyp_native'];
    assert(
      tokenProgramId,
      'Expected native token program to be deployed but none was found in deployment mapping',
    );

    // Initialize token
    const initTx = getCreateNativeTokenTx(tokenProgramId);
    const initReceipt = await this.signer
      .sendAndConfirmTransaction(initTx)
      .catch((error: unknown) => {
        throw withErrorContext(
          `Failed to initialize native warp token program ${tokenProgramId} (signer=${signerAddress})`,
          error,
        );
      });
    allReceipts.push(initReceipt);

    const tokenAddress = toAleoAddress(tokenProgramId);

    // Perform post-deployment updates (ISM setup and router enrollment)
    const postDeploymentTxs = getPostDeploymentUpdateTxs(tokenAddress, config);

    for (const tx of postDeploymentTxs) {
      const receipt = await this.signer
        .sendAndConfirmTransaction(tx)
        .catch((error: unknown) => {
          throw withErrorContext(
            `Failed post-deployment step ${tx.programName}.${tx.functionName} for native warp token ${tokenAddress} (signer=${signerAddress})`,
            error,
          );
        });
      allReceipts.push(receipt);
    }

    const deployedArtifact: ArtifactDeployed<
      OrchestratedRawNativeWarpArtifactConfig,
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
      OrchestratedRawNativeWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedAleoTransaction[]> {
    // Read current state from chain
    const currentArtifact = await this.read(artifact.deployed.address);

    // Generate update transactions
    return getWarpTokenUpdateTxs(artifact, currentArtifact);
  }
}
