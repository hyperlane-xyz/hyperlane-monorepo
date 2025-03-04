import fetch from 'cross-fetch';
import { Logger } from 'pino';

import { buildArtifact } from '@hyperlane-xyz/core/buildArtifact-zksync.js';
import { rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainName } from '../../types.js';

import { BaseContractVerifier } from './BaseContractVerifier.js';
import {
  BuildArtifact,
  ContractVerificationInput,
  SolidityStandardJsonInput,
  ZKSyncCompilerOptions,
} from './types.js';

/**
 * @title ZKSyncContractVerifier
 * @notice Handles the verification of ZkSync contracts on block explorers
 * @dev This class manages the process of verifying ZkSync contracts, including
 * preparing verification data and submitting it to the appropriate explorer API
 * Note: Etherscan verification is managed by the ContractVerifier class
 * Blockscout verification is not currently supported on ZkSync
 */
export class ZKSyncContractVerifier extends BaseContractVerifier {
  protected logger = rootLogger.child({ module: 'ZKSyncContractVerifier' });

  protected readonly standardInputJson: SolidityStandardJsonInput;
  protected readonly compilerOptions: ZKSyncCompilerOptions;

  /**
   * @notice Creates a new ZKSyncContractVerifier instance
   * @param multiProvider An instance of MultiProvider for interacting with multiple chains
   */
  constructor(protected readonly multiProvider: MultiProvider) {
    super(multiProvider, buildArtifact);
    this.standardInputJson = (buildArtifact as BuildArtifact).input;

    const compilerZksolcVersion = `v${
      (buildArtifact as { zk_version: string }).zk_version
    }`;
    const compilerSolcVersion = (buildArtifact as BuildArtifact)
      .solcLongVersion;

    this.compilerOptions = {
      codeFormat: 'solidity-standard-json-input',
      compilerSolcVersion,
      compilerZksolcVersion,
      optimizationUsed: true,
    };
  }

  /**
   * @notice Verifies a contract on the specified chain
   * @param chain The name of the chain where the contract is deployed
   * @param input The contract verification input data
   * @param verificationLogger A logger instance for verification-specific logging
   */
  protected async verify(
    chain: ChainName,
    input: ContractVerificationInput,
    verificationLogger: Logger,
  ): Promise<void> {
    const contractType: string = input.isProxy ? 'proxy' : 'implementation';

    verificationLogger.debug(`📝 Verifying ${contractType}...`);

    const data = this.getImplementationData(chain, input, verificationLogger);

    try {
      const verificationId: string = await this.submitForm(
        chain,
        verificationLogger,
        data,
      );

      verificationLogger.trace(
        { verificationId },
        `Retrieved verificationId from verified ${contractType}.`,
      );
    } catch (error) {
      verificationLogger.debug(
        { error },
        `Verification of ${contractType} failed`,
      );
      throw error;
    }
  }

  protected prepareImplementationData(
    sourceName: string,
    input: ContractVerificationInput,
    filteredStandardInputJson: SolidityStandardJsonInput,
  ) {
    return {
      sourceCode: filteredStandardInputJson,
      contractName: `${sourceName}:${input.name}`,
      contractAddress: input.address,
      constructorArguments: `0x${input.constructorArguments || ''}`,
      ...this.compilerOptions,
    };
  }

  /**
   * @notice Submits the verification form to the explorer API
   * @param chain The name of the chain where the contract is deployed
   * @param verificationLogger A logger instance for verification-specific logging
   * @param options Additional options for the API request
   * @returns The response from the explorer API
   */
  private async submitForm(
    chain: ChainName,
    verificationLogger: Logger,
    options?: Record<string, any>,
  ): Promise<any> {
    const { apiUrl, family } = this.multiProvider.getExplorerApi(chain);

    const url = new URL(apiUrl);
    verificationLogger.trace(
      { apiUrl, chain },
      'Sending request to explorer...',
    );

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    let responseJson;
    try {
      responseJson = await response.json();
      verificationLogger.trace(
        { apiUrl, chain },
        'Parsing response from explorer...',
      );
    } catch (error) {
      verificationLogger.trace(
        {
          error,
          failure: response.statusText,
          status: response.status,
          chain,
          apiUrl,
          family,
        },
        'Failed to parse response from explorer.',
      );
      throw new Error(
        `Failed to parse response from explorer (${apiUrl}, ${chain}): ${
          response.statusText || 'UNKNOWN STATUS TEXT'
        } (${response.status || 'UNKNOWN STATUS'})`,
      );
    }

    return responseJson;
  }
}
