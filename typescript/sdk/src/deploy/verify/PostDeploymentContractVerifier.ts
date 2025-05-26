import { rootLogger } from '@hyperlane-xyz/utils';

import { ExplorerFamily } from '../../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainMap } from '../../types.js';
import { MultiGeneric } from '../../utils/MultiGeneric.js';

import { BaseContractVerifier } from './BaseContractVerifier.js';
import { ContractVerifier } from './ContractVerifier.js';
import { ZKSyncContractVerifier } from './ZKSyncContractVerifier.js';
import { BuildArtifact, CompilerOptions, VerificationInput } from './types.js';

export class PostDeploymentContractVerifier extends MultiGeneric<VerificationInput> {
  protected logger = rootLogger.child({
    module: 'PostDeploymentContractVerifier',
  });
  protected contractVerifier: BaseContractVerifier;
  protected zkSyncContractVerifier: ZKSyncContractVerifier;

  constructor(
    verificationInputs: ChainMap<VerificationInput>,
    protected readonly multiProvider: MultiProvider,
    apiKeys: ChainMap<string>,
    buildArtifact: BuildArtifact,
    licenseType: CompilerOptions['licenseType'],
  ) {
    super(verificationInputs);
    this.contractVerifier = new ContractVerifier(
      multiProvider,
      apiKeys,
      buildArtifact,
      licenseType,
    );
    this.zkSyncContractVerifier = new ZKSyncContractVerifier(multiProvider);
  }

  verify(targets = this.chains()): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled(
      targets.map(async (chain) => {
        // can check explorer family here to avoid doing these checks for each input in verifier
        const { family } = this.multiProvider.getExplorerApi(chain);
        let contractVerifier: BaseContractVerifier = this.contractVerifier;

        if (family === ExplorerFamily.ZkSync) {
          this.logger.debug('Using ZkSync verifier');
          contractVerifier = this.zkSyncContractVerifier;
        }

        if (family === ExplorerFamily.Other) {
          this.logger.warn(
            `Skipping verification for ${chain} due to unsupported explorer family.`,
          );
          return;
        }

        this.logger.debug(`Verifying ${chain}...`);
        for (const input of this.get(chain)) {
          try {
            await contractVerifier.verifyContract(chain, input, this.logger);
          } catch (error) {
            this.logger.error(
              { name: input.name, address: input.address },
              `Failed to verify contract on ${chain}`,
              error,
            );
          }
        }
      }),
    );
  }
}
