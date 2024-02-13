import { debug } from 'debug';

import { ExplorerFamily } from '../../metadata/chainMetadataTypes';
import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap } from '../../types';
import { MultiGeneric } from '../../utils/MultiGeneric';

import { ContractVerifier } from './ContractVerifier';
import { CompilerOptions, VerificationInput } from './types';

export class PostDeploymentContractVerifier extends MultiGeneric<VerificationInput> {
  protected logger = debug('hyperlane:PostDeploymentContractVerifier');
  private contractVerifier: ContractVerifier;

  constructor(
    verificationInputs: ChainMap<VerificationInput>,
    private multiProvider: MultiProvider,
    apiKeys: ChainMap<string>,
    source: string, // solidity standard input json
    compilerOptions: Partial<Omit<CompilerOptions, 'codeformat'>>,
  ) {
    super(verificationInputs);
    this.contractVerifier = new ContractVerifier(
      multiProvider,
      apiKeys,
      source,
      compilerOptions,
    );
  }

  verify(targets = this.chains()): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled(
      targets.map(async (chain) => {
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
