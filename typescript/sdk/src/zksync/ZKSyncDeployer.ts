import { BigNumber, BytesLike, Overrides, utils } from 'ethers';
import {
  Contract,
  ContractFactory,
  Provider,
  Wallet,
  types as zksyncTypes,
} from 'zksync-ethers';

import { ZKSyncArtifact, loadAllZKSyncArtifacts } from '@hyperlane-xyz/core';
import { assert } from '@hyperlane-xyz/utils';

/**
 * An entity capable of deploying contracts to the zkSync network.
 */
export class ZKSyncDeployer {
  public zkWallet: Wallet;
  public deploymentType?: zksyncTypes.DeploymentType;

  constructor(zkWallet: Wallet, deploymentType?: zksyncTypes.DeploymentType) {
    this.deploymentType = deploymentType;

    const zkWeb3Provider = new Provider('http://127.0.0.1:8011', 260);

    const l2Provider =
      zkWallet.provider === null ? zkWeb3Provider : zkWallet.provider;

    this.zkWallet = zkWallet.connect(l2Provider);
  }

  public async loadArtifact(contractTitle: string): Promise<ZKSyncArtifact> {
    const zksyncArtifacts = await loadAllZKSyncArtifacts();
    const artifact = (Object.values(zksyncArtifacts) as ZKSyncArtifact[]).find(
      ({ contractName, sourceName }) => {
        if (contractName === contractTitle) {
          return true;
        }

        const qualifiedName = `${sourceName}:${contractName}`;
        if (contractTitle === qualifiedName) {
          return true;
        }

        return false;
      },
    );

    assert(artifact, `No ZKSync artifact for contract ${contractTitle} found!`);

    return artifact as any;
  }

  /**
   * Estimates the price of calling a deploy transaction in ETH.
   *
   * @param artifact The previously loaded artifact object.
   * @param constructorArguments List of arguments to be passed to the contract constructor.
   *
   * @returns Calculated fee in ETH wei
   */
  public async estimateDeployFee(
    artifact: ZKSyncArtifact,
    constructorArguments: any[],
  ): Promise<BigNumber> {
    const gas = await this.estimateDeployGas(artifact, constructorArguments);
    const gasPrice = await this.zkWallet.provider.getGasPrice();
    return gas.mul(gasPrice);
  }

  /**
   * Estimates the amount of gas needed to execute a deploy transaction.
   *
   * @param artifact The previously loaded artifact object.
   * @param constructorArguments List of arguments to be passed to the contract constructor.
   *
   * @returns Calculated amount of gas.
   */
  public async estimateDeployGas(
    artifact: ZKSyncArtifact,
    constructorArguments: any[],
  ): Promise<BigNumber> {
    const factoryDeps = await this.extractFactoryDeps(artifact);

    const factory = new ContractFactory(
      artifact.abi,
      artifact.bytecode,
      this.zkWallet,
      this.deploymentType,
    );

    // Encode deploy transaction so it can be estimated.
    const deployTx = factory.getDeployTransaction(...constructorArguments, {
      customData: {
        factoryDeps,
      },
    });
    deployTx.from = this.zkWallet.address;

    return this.zkWallet.provider.estimateGas(deployTx);
  }

  /**
   * Sends a deploy transaction to the zkSync network.
   * For now, it will use defaults for the transaction parameters:
   * - fee amount is requested automatically from the zkSync server.
   *
   * @param artifact The previously loaded artifact object.
   * @param constructorArguments List of arguments to be passed to the contract constructor.
   * @param overrides Optional object with additional deploy transaction parameters.
   * @param additionalFactoryDeps Additional contract bytecodes to be added to the factory dependencies list.
   *
   * @returns A contract object.
   */
  public async deploy(
    artifact: ZKSyncArtifact,
    constructorArguments: any[] = [],
    overrides?: Overrides,
    additionalFactoryDeps?: BytesLike[],
  ): Promise<Contract> {
    const baseDeps = await this.extractFactoryDeps(artifact);
    const additionalDeps = additionalFactoryDeps
      ? additionalFactoryDeps.map((val) => utils.hexlify(val))
      : [];
    const factoryDeps = [...baseDeps, ...additionalDeps];

    const factory = new ContractFactory(
      artifact.abi,
      artifact.bytecode,
      this.zkWallet,
      this.deploymentType,
    );

    const { customData, ..._overrides } = overrides ?? {};

    // Encode and send the deploy transaction providing factory dependencies.
    const contract = await factory.deploy(...constructorArguments, {
      ..._overrides,
      customData: {
        ...customData,
        factoryDeps,
      },
    });

    await contract.deployed();

    return contract;
  }

  /**
   * Extracts factory dependencies from the artifact.
   *
   * @param artifact Artifact to extract dependencies from
   *
   * @returns Factory dependencies in the format expected by SDK.
   */
  async extractFactoryDeps(artifact: ZKSyncArtifact): Promise<string[]> {
    const visited = new Set<string>();

    visited.add(`${artifact.sourceName}:${artifact.contractName}`);
    return this.extractFactoryDepsRecursive(artifact, visited);
  }

  private async extractFactoryDepsRecursive(
    artifact: ZKSyncArtifact,
    visited: Set<string>,
  ): Promise<string[]> {
    // Load all the dependency bytecodes.
    // We transform it into an array of bytecodes.
    const factoryDeps: string[] = [];
    for (const dependencyHash in artifact.factoryDeps) {
      if (
        Object.prototype.hasOwnProperty.call(
          artifact.factoryDeps,
          dependencyHash,
        )
      ) {
        const dependencyContract = artifact.factoryDeps[dependencyHash];
        if (!visited.has(dependencyContract)) {
          const dependencyArtifact = await this.loadArtifact(
            dependencyContract,
          );
          factoryDeps.push(dependencyArtifact.bytecode);
          visited.add(dependencyContract);
          const transitiveDeps = await this.extractFactoryDepsRecursive(
            dependencyArtifact,
            visited,
          );
          factoryDeps.push(...transitiveDeps);
        }
      }
    }

    return factoryDeps;
  }
}
