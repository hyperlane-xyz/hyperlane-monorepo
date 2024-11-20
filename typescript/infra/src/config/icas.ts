import { ethers } from 'ethers';

import {
  AccountConfig,
  ChainMap,
  ChainName,
  EV5JsonRpcTxSubmitter,
  EvmIsmModule,
  InterchainAccount,
  IsmConfig,
  MultiProvider,
  normalizeConfig,
} from '@hyperlane-xyz/sdk';
import { Address, deepEquals, eqAddress } from '@hyperlane-xyz/utils';

import { getAbacusWorksIcasPath } from '../../scripts/agent-utils.js';
import { readJSONAtPath, writeMergedJSONAtPath } from '../utils/utils.js';

import { DeployEnvironment } from './environment.js';

export interface IcaArtifact {
  ica: Address;
  ism: Address;
}

export interface IcaDeployResult {
  chain: string;
  result?: IcaArtifact;
  error?: string;
  deployed?: string;
  recovered?: string;
}

export function persistAbacusWorksIcas(
  environment: DeployEnvironment,
  icas: ChainMap<IcaArtifact>,
) {
  // Write the updated object back to the file
  writeMergedJSONAtPath(getAbacusWorksIcasPath(environment), icas);
}

export function readAbacusWorksIcas(
  environment: DeployEnvironment,
): Promise<ChainMap<IcaArtifact>> {
  return readJSONAtPath(getAbacusWorksIcasPath(environment));
}

export class AbacusWorksIcaManager {
  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly ica: InterchainAccount,
    private readonly chainAddresses: ChainMap<Record<string, string>>,
    private readonly deployer: Address,
    private readonly getIcaIsm: (
      originChain: ChainName,
      deployer: Address,
      routingIsmOwner: Address,
    ) => IsmConfig,
  ) {}

  /**
   * Gets the ICA address using the owner config and ISM address
   */
  public async getIcaAccount(
    ownerConfig: AccountConfig,
    icaChain: ChainName,
    ismAddress: Address,
  ): Promise<string> {
    // Create owner config with ISM override
    const chainOwnerConfig = {
      ...ownerConfig,
      ismOverride: ismAddress,
    };

    // Get the ICA address using the owner config
    return this.ica.getAccount(icaChain, chainOwnerConfig);
  }

  /**
   * Verifies or deploys the ICA for a given chain.
   * @param chain - The chain to process.
   * @param options - The options for verifying or deploying the ICA.
   * @returns The result of verifying or deploying the ICA.
   */
  public async verifyOrDeployChainIca(
    chain: string,
    {
      ownerConfig,
      chainArtifact,
      deploy,
    }: {
      ownerConfig: AccountConfig;
      chainArtifact?: IcaArtifact;
      deploy: boolean;
    },
  ): Promise<IcaDeployResult> {
    // Try to recover existing ICA
    if (
      chainArtifact &&
      !eqAddress(chainArtifact.ism, ethers.constants.AddressZero)
    ) {
      console.log(
        'Attempting ICA recovery on chain',
        chain,
        'with existing artifact',
        chainArtifact,
      );

      const matches = await this.artifactMatchesExpectedConfig(
        ownerConfig,
        chain,
        chainArtifact,
      );

      if (matches) {
        console.log('Recovered ICA on chain', chain);
        return {
          chain,
          result: chainArtifact,
          deployed: '✅',
          recovered: '✅',
        };
      }

      console.warn(
        `Chain ${chain} ICA artifact does not match expected config, will redeploy`,
      );
    }

    // Handle case where deployment is not allowed
    if (!deploy) {
      console.log(
        'Skipping required ISM deployment for chain',
        chain,
        ', will not have an ICA',
      );
      return {
        chain,
        result: {
          ica: ethers.constants.AddressZero,
          ism: ethers.constants.AddressZero,
        },
        deployed: '❌',
        recovered: '❌',
      };
    }

    // Deploy new ICA
    return this.deployNewIca(chain, ownerConfig);
  }

  /**
   * Verifies that an ICA artifact matches the expected configuration by:
   * 1. Checking that the ISM configuration matches what we expect
   * 2. Verifying we can recover the correct ICA address
   *
   * @param originChain - The chain where the owner account exists
   * @param originOwner - The address of the owner account
   * @param icaChain - The chain where the ICA exists
   * @param icaArtifact - The artifact containing ICA and ISM addresses
   * @returns True if the artifact matches expected config, false otherwise
   */
  public async artifactMatchesExpectedConfig(
    ownerConfig: AccountConfig,
    icaChain: ChainName,
    icaArtifact: IcaArtifact,
  ): Promise<boolean> {
    const ismMatches = await this.verifyIsmConfig(icaChain, icaArtifact);
    if (!ismMatches) {
      return false;
    }
    return this.canRecoverIca(ownerConfig, icaChain, icaArtifact);
  }

  /**
   * Deploys a new Interchain Account (ICA) and its associated ISM on the specified chain
   *
   * The deployment process:
   * 1. Deploy ISM with deployer as initial owner
   * 2. Deploy ICA using the ISM
   * 3. Update ISM owner to point to the deployed ICA
   * 4. Verify the deployment matches expected config
   *
   * @param chain - The destination chain for the ICA deployment
   * @param ownerConfig - Configuration for the ICA owner
   * @returns ICA deployment result with addresses and status
   */
  public async deployNewIca(
    chain: string,
    ownerConfig: AccountConfig,
  ): Promise<IcaDeployResult> {
    // Deploy ISM with deployer as initial owner
    const { ismModule, ismAddress } = await this.deployInitialIsm(chain);

    // Deploy ICA using the ISM
    const deployedIca = await this.deployIcaWithIsm(
      chain,
      ownerConfig,
      ismAddress,
    );

    // Update ISM owner to point to deployed ICA
    await this.updateIsmOwner(chain, ismModule, deployedIca);

    // Record deployed addresses
    const newChainArtifact = {
      ica: deployedIca,
      ism: ismAddress,
    };

    const matches = await this.artifactMatchesExpectedConfig(
      ownerConfig,
      chain,
      newChainArtifact,
    );

    if (!matches) {
      console.log(
        `Somehow after everything, the ICA artifact on chain ${chain} still does not match the expected config! There's probably a bug.`,
      );
      return { chain, result: undefined, deployed: '❌', recovered: '❌' };
    }

    return { chain, result: newChainArtifact, deployed: '✅', recovered: '❌' };
  }

  /**
   * Verifies that the ISM configuration matches what we expect
   *
   * @param icaChain - The chain where the ISM exists
   * @param icaArtifact - The artifact containing the ISM address
   * @returns True if ISM config matches expected config, false otherwise
   */
  private async verifyIsmConfig(
    icaChain: ChainName,
    icaArtifact: IcaArtifact,
  ): Promise<boolean> {
    // Get the desired ISM config - the owner should be the ICA itself
    const desiredIsmConfig = this.getIcaIsm(
      icaChain,
      this.deployer,
      icaArtifact.ica,
    );

    // Create ISM module to interact with the deployed ISM
    const ismModule = new EvmIsmModule(this.multiProvider, {
      chain: icaChain,
      config: desiredIsmConfig,
      addresses: {
        ...(this.chainAddresses[icaChain] as any),
        deployedIsm: icaArtifact.ism,
      },
    });

    // Read the actual config from the deployed ISM
    const actualIsmConfig = await ismModule.read();

    // Compare normalized configs to handle any formatting differences
    const configsMatch = deepEquals(
      normalizeConfig(actualIsmConfig),
      normalizeConfig(desiredIsmConfig),
    );

    if (!configsMatch) {
      console.log('ISM mismatch for', icaChain);
      console.log('actualIsmConfig:', JSON.stringify(actualIsmConfig));
      console.log('desiredIsmConfig:', JSON.stringify(desiredIsmConfig));
    }

    return configsMatch;
  }

  /**
   * Verifies that we can recover the correct ICA address using the owner config
   *
   * @param originChain - The chain where the owner account exists
   * @param originOwner - The address of the owner account
   * @param icaChain - The chain where the ICA exists
   * @param icaArtifact - The artifact containing the ICA address
   * @returns True if recovered address matches artifact, false otherwise
   */
  private async canRecoverIca(
    ownerConfig: AccountConfig,
    icaChain: ChainName,
    icaArtifact: IcaArtifact,
  ): Promise<boolean> {
    // Try to recover the ICA address using the owner config
    const account = await this.getIcaAccount(
      ownerConfig,
      icaChain,
      icaArtifact.ism,
    );

    // Check if recovered address matches the artifact
    const accountMatches = eqAddress(account, icaArtifact.ica);
    if (!accountMatches) {
      console.error(
        `⚠️⚠️⚠️ Failed to recover ICA for ${icaChain}. Expected: ${
          icaArtifact.ica
        }, got: ${account}. Chain owner config: ${JSON.stringify({
          origin: ownerConfig.origin,
          owner: ownerConfig.owner,
          ismOverride: icaArtifact.ism,
        })} ⚠️⚠️⚠️`,
      );
    }

    return accountMatches;
  }

  /**
   * Deploys the initial ISM with the deployer as the owner
   *
   * @param chain - The destination chain for the ICA deployment
   * @returns ISM module and address
   */
  private async deployInitialIsm(chain: ChainName) {
    // Initially configure ISM with deployer as owner since ICA address is unknown
    const deployerOwnedIsm = this.getIcaIsm(
      chain,
      this.deployer,
      this.deployer,
    );

    console.log('Deploying ISM for ICA on chain', chain);
    // Create and deploy the ISM module
    const ismModule = await EvmIsmModule.create({
      chain,
      config: deployerOwnedIsm,
      proxyFactoryFactories: this.chainAddresses[chain] as any,
      multiProvider: this.multiProvider,
      mailbox: this.chainAddresses[chain].mailbox,
    });

    return {
      ismModule,
      ismAddress: ismModule.serialize().deployedIsm,
    };
  }

  /**
   * Deploys the ICA using the deployed ISM
   *
   * @param chain - The destination chain for the ICA deployment
   * @param ownerConfig - Configuration for the ICA owner
   * @param ismAddress - The address of the deployed ISM
   * @returns The address of the deployed ICA
   */
  private async deployIcaWithIsm(
    chain: ChainName,
    ownerConfig: AccountConfig,
    ismAddress: Address,
  ) {
    // Configure ICA with deployed ISM address
    const chainOwnerConfig = {
      ...ownerConfig,
      ismOverride: ismAddress,
    };

    console.log(
      'Deploying ICA on chain',
      chain,
      'with owner config',
      chainOwnerConfig,
    );

    // Deploy the ICA
    const deployedIca = await this.ica.deployAccount(chain, chainOwnerConfig);
    console.log(`Deployed ICA on chain: ${chain}: ${deployedIca}`);

    return deployedIca;
  }

  /**
   * Updates the ISM owner to point to the deployed ICA
   *
   * @param chain - The destination chain for the ICA deployment
   * @param ismModule - The ISM module to update
   * @param deployedIca - The address of the deployed ICA
   */
  private async updateIsmOwner(
    chain: ChainName,
    ismModule: EvmIsmModule,
    deployedIca: Address,
  ) {
    // Update ISM config to point to deployed ICA as owner
    const icaOwnedIsmConfig = this.getIcaIsm(chain, this.deployer, deployedIca);

    // Submit ISM update transaction
    const submitter = new EV5JsonRpcTxSubmitter(this.multiProvider, {
      chain,
    });
    const updateTxs = await ismModule.update(icaOwnedIsmConfig);
    console.log(
      `Updating routing ISM owner on ${chain} with transactions:`,
      updateTxs,
    );
    await submitter.submit(...updateTxs);
  }
}
