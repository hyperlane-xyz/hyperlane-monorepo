import { debug } from 'debug';

import { ExplorerFamily } from '../../metadata/chainMetadataTypes';
import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap } from '../../types';
import { MultiGeneric } from '../../utils/MultiGeneric';

import { ContractVerifier } from './ContractVerifier';
import { BuildArtifact, CompilerOptions, VerificationInput } from './types';

export class PostDeploymentContractVerifier extends MultiGeneric<VerificationInput> {
  protected logger = debug('hyperlane:PostDeploymentContractVerifier');
  private contractVerifier: ContractVerifier;

  constructor(
    verificationInputs: ChainMap<VerificationInput>,
    private multiProvider: MultiProvider,
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
  }

  verify(targets = this.chains()): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled(
      targets.map(async (chain) => {
        // can check explorer family here to avoid doing these checks for each input in verifier
        const { family } = this.multiProvider.getExplorerApi(chain);
        if (family === ExplorerFamily.Other) {
          this.logger(
            `Skipping verification for ${chain} due to unsupported explorer family.`,
          );
          return;
        }

        this.logger(`Verifying ${chain}...`);
        for (const input of this.get(chain)) {
          await this.contractVerifier.verifyContract(chain, input, this.logger);
        }
      }),
    );
  }
}
