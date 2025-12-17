import { type Logger } from 'pino';

import { buildArtifact as zksyncBuildArtifact } from '@hyperlane-xyz/core/buildArtifact-zksync.js';
import {
  type Address,
  assert,
  retryAsync,
  rootLogger,
  strip0x,
} from '@hyperlane-xyz/utils';

import {
  checkContractVerificationStatus,
  getContractSourceCode,
  verifyContractSourceCodeViaStandardJsonInput,
  verifyProxyContract,
} from '../../block-explorer/etherscan.js';
import { type MultiProvider } from '../../providers/MultiProvider.js';
import { ContractVerificationStatus } from '../../token/types.js';
import { type ChainMap, type ChainName } from '../../types.js';

import { BaseContractVerifier } from './BaseContractVerifier.js';
import {
  type BuildArtifact,
  type CompilerOptions,
  type ContractVerificationInput,
  type SolidityStandardJsonInput,
} from './types.js';

export class ContractVerifier extends BaseContractVerifier {
  protected logger = rootLogger.child({ module: 'ContractVerifier' });
  protected readonly compilerOptions: CompilerOptions;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly apiKeys: ChainMap<string>,
    buildArtifact: BuildArtifact,
    licenseType: CompilerOptions['licenseType'],
  ) {
    super(multiProvider, buildArtifact);
    const compilerversion = `v${buildArtifact.solcLongVersion}`;
    const versionRegex = /v(\d.\d.\d+)\+commit.\w+/;
    const matches = versionRegex.exec(compilerversion);
    if (!matches) {
      throw new Error(`Invalid compiler version ${compilerversion}`);
    }
    this.compilerOptions = {
      codeformat: 'solidity-standard-json-input',
      compilerversion,
      licenseType,
    };
    if (zksyncBuildArtifact?.zk_version)
      this.compilerOptions.zksolcversion = `v${zksyncBuildArtifact.zk_version}`;
  }

  protected async verify(
    chain: ChainName,
    input: ContractVerificationInput,
    verificationLogger: Logger,
  ): Promise<void> {
    const contractType: string = input.isProxy ? 'proxy' : 'implementation';

    try {
      const verificationStatus = await this.getContractVerificationStatus(
        chain,
        input.address,
        verificationLogger,
      );

      if (
        verificationStatus === ContractVerificationStatus.Verified ||
        verificationStatus === ContractVerificationStatus.Skipped
      ) {
        verificationLogger.debug(
          `Contract ${contractType} at address "${input.address}" on chain "${chain}" is already verified. Skipping...`,
        );
        return;
      }

      let verificationId: string;
      if (input.isProxy) {
        verificationId = await this.verifyProxy(chain, input);
      } else {
        verificationId = await this.verifyImplementation(
          chain,
          input,
          verificationLogger,
        );
      }

      verificationLogger.debug(
        `Verification request for ${contractType} contract at address "${input.address}" on chain "${chain}" sent. GUID ${verificationId}`,
      );

      await this.checkStatus(
        chain,
        verificationId,
        !!input.isProxy,
        verificationLogger,
      );
      verificationLogger.debug(
        `Contract ${contractType} at address "${input.address}" on chain "${chain}" successfully verified`,
      );
    } catch (err) {
      verificationLogger.error(
        `Failed to verify ${contractType} contract at address "${input.address}" on chain "${chain}"`,
        err,
      );
    }
  }

  private async verifyImplementation(
    chain: ChainName,
    input: ContractVerificationInput,
    verificationLogger: Logger,
  ): Promise<string> {
    const { apiUrl, apiKey } = this.multiProvider.getEvmExplorerMetadata(chain);

    const data = this.getImplementationData(chain, input, verificationLogger);
    return verifyContractSourceCodeViaStandardJsonInput(
      {
        apiUrl,
        apiKey,
      },
      {
        compilerVersion: this.compilerOptions.compilerversion,
        constructorArguments: input.constructorArguments,
        contractAddress: input.address,
        contractName: data.contractname,
        sourceCode: data.sourceCode,
        licenseType: this.compilerOptions.licenseType,
        zkCompilerVersion: this.compilerOptions.zksolcversion,
      },
    );
  }

  private async verifyProxy(
    chain: ChainName,
    input: ContractVerificationInput,
  ): Promise<string> {
    assert(
      input.expectedimplementation,
      `Implementation address not provided for proxied contract at address "${input.address}" on chain "${chain}". Skipping verification`,
    );

    const { apiUrl, apiKey } = this.multiProvider.getEvmExplorerMetadata(chain);
    return verifyProxyContract(
      {
        apiUrl,
        apiKey,
      },
      {
        implementationAddress: input.expectedimplementation,
        contractAddress: input.address,
      },
    );
  }

  private async checkStatus(
    chain: ChainName,
    verificationId: string,
    isProxy: boolean,
    verificationLogger: Logger,
  ): Promise<void> {
    const contractType: string = isProxy ? 'proxy' : 'implementation';
    verificationLogger.trace(
      { verificationId },
      `Checking ${contractType} verification status on chain "${chain}"...`,
    );

    const { apiUrl, apiKey } = this.multiProvider.getEvmExplorerMetadata(chain);
    await retryAsync(
      () =>
        checkContractVerificationStatus(
          {
            apiUrl,
            apiKey,
          },
          { isProxy, verificationId },
        ),
      undefined,
      1000,
    );
  }

  protected prepareImplementationData(
    sourceName: string,
    input: ContractVerificationInput,
    filteredStandardInputJson: SolidityStandardJsonInput,
  ) {
    return {
      sourceCode: filteredStandardInputJson,
      contractname: `${sourceName}:${input.name}`,
      contractaddress: input.address,
      constructorArguements: strip0x(input.constructorArguments ?? ''),
      ...this.compilerOptions,
    };
  }

  async getContractVerificationStatus(
    chain: ChainName,
    address: Address,
    verificationLogger: Logger = this.logger,
  ): Promise<ContractVerificationStatus> {
    try {
      const { apiUrl, apiKey } =
        this.multiProvider.getEvmExplorerMetadata(chain);

      verificationLogger.trace(
        `Fetching contract ABI for ${chain} address ${address}`,
      );
      const sourceCodeResults = await getContractSourceCode(
        {
          apiUrl,
          apiKey,
        },
        { contractAddress: address },
      );

      // Explorer won't return ContractName if unverified
      return sourceCodeResults.ContractName
        ? ContractVerificationStatus.Verified
        : ContractVerificationStatus.Unverified;
    } catch (e) {
      this.logger.error(
        `Error fetching contract verification status for ${address} on chain ${chain}: ${e}`,
      );
      return ContractVerificationStatus.Error;
    }
  }
}
