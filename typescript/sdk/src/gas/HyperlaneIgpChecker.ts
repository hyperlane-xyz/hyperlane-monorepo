import { BigNumber, ethers, utils as ethersUtils } from 'ethers';

import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { BytecodeHash } from '../consts/bytecode';
import { HyperlaneAppChecker } from '../deploy/HyperlaneAppChecker';
import { proxyImplementation } from '../deploy/proxy';
import { ChainName } from '../types';

import { HyperlaneIgp } from './HyperlaneIgp';
import {
  GasOracleContractType,
  IgpBeneficiaryViolation,
  IgpConfig,
  IgpGasOraclesViolation,
  IgpOverheadViolation,
  IgpViolationType,
} from './types';

export class HyperlaneIgpChecker extends HyperlaneAppChecker<
  HyperlaneIgp,
  IgpConfig
> {
  async checkChain(chain: ChainName): Promise<void> {
    await this.checkDomainOwnership(chain);
    await this.checkProxiedContracts(chain);
    await this.checkBytecodes(chain);
    await this.checkOverheadInterchainGasPaymaster(chain);
    await this.checkInterchainGasPaymaster(chain);
  }

  async checkDomainOwnership(chain: ChainName): Promise<void> {
    const config = this.configMap[chain];

    const ownableOverrides: Record<string, string> = {
      storageGasOracle: config.oracleKey,
    };
    await super.checkOwnership(chain, config.owner, ownableOverrides);
  }

  async checkBytecodes(chain: ChainName): Promise<void> {
    const contracts = this.app.getContracts(chain);
    await this.checkBytecode(
      chain,
      'InterchainGasPaymaster proxy',
      contracts.interchainGasPaymaster.address,
      [BytecodeHash.TRANSPARENT_PROXY_BYTECODE_HASH],
    );
    const implementation = await proxyImplementation(
      this.multiProvider.getProvider(chain),
      contracts.interchainGasPaymaster.address,
    );
    await this.checkBytecode(
      chain,
      'InterchainGasPaymaster implementation',
      implementation,
      [
        BytecodeHash.INTERCHAIN_GAS_PAYMASTER_BYTECODE_HASH,
        BytecodeHash.OWNER_INITIALIZABLE_INTERCHAIN_GAS_PAYMASTER_BYTECODE_HASH,
      ],
    );

    await this.checkBytecode(
      chain,
      'InterchainGasPaymaster',
      contracts.interchainGasPaymaster.address,
      [BytecodeHash.OVERHEAD_IGP_BYTECODE_HASH],
      (bytecode) =>
        // Remove the address of the wrapped IGP from the bytecode
        bytecode.replaceAll(
          ethersUtils.defaultAbiCoder
            .encode(['address'], [contracts.interchainGasPaymaster.address])
            .slice(2),
          '',
        ),
    );
  }

  async checkOverheadInterchainGasPaymaster(local: ChainName): Promise<void> {
    const coreContracts = this.app.getContracts(local);
    const defaultIsmIgp = coreContracts.interchainGasPaymaster;

    // Construct the violation, updating the actual & expected
    // objects as violations are found.
    // A single violation is used so that only a single `setDestinationGasOverheads`
    // call is generated to set multiple gas overheads.
    const overheadViolation: IgpOverheadViolation = {
      type: 'InterchainGasPaymaster',
      subType: IgpViolationType.Overhead,
      contract: defaultIsmIgp,
      chain: local,
      actual: {},
      expected: {},
    };

    const remotes = this.app.remoteChains(local);
    for (const remote of remotes) {
      let expectedOverhead = this.configMap[local].overhead[remote];
      if (!expectedOverhead) {
        this.app.logger(
          `No overhead configured for ${local} -> ${remote}, defaulting to 0`,
        );
        expectedOverhead = 0;
      }

      const remoteId = this.multiProvider.getDomainId(remote);
      const existingOverhead = await defaultIsmIgp.destinationGasLimit(
        remoteId,
        0,
      );
      if (!existingOverhead.eq(expectedOverhead)) {
        const remoteChain = remote as ChainName;
        overheadViolation.actual[remoteChain] = existingOverhead;
        overheadViolation.expected[remoteChain] =
          BigNumber.from(expectedOverhead);
      }
    }

    if (Object.keys(overheadViolation.actual).length > 0) {
      this.addViolation(overheadViolation);
    }
  }

  async checkInterchainGasPaymaster(local: ChainName): Promise<void> {
    const coreContracts = this.app.getContracts(local);
    const igp = coreContracts.interchainGasPaymaster;

    // Construct the violation, updating the actual & expected
    // objects as violations are found.
    // A single violation is used so that only a single `setGasOracles`
    // call is generated to set multiple gas oracles.
    const gasOraclesViolation: IgpGasOraclesViolation = {
      type: 'InterchainGasPaymaster',
      subType: IgpViolationType.GasOracles,
      contract: igp,
      chain: local,
      actual: {},
      expected: {},
    };

    // In addition to all remote chains on the app, which are just Ethereum chains,
    // also consider what the config says about non-Ethereum chains.
    const remotes = new Set([
      ...this.app.remoteChains(local),
      ...Object.keys(this.configMap[local].gasOracleType),
    ]);
    for (const remote of remotes) {
      const remoteId = this.multiProvider.getDomainId(remote);
      const destinationGasConfigs = await igp.destinationGasConfigs(remoteId);
      const actualGasOracle = destinationGasConfigs.gasOracle;
      const expectedGasOracle = this.getGasOracleAddress(local, remote);

      if (!eqAddress(actualGasOracle, expectedGasOracle)) {
        const remoteChain = remote as ChainName;
        gasOraclesViolation.actual[remoteChain] = actualGasOracle;
        gasOraclesViolation.expected[remoteChain] = expectedGasOracle;
      }
    }
    // Add the violation only if it's been populated with gas oracle inconsistencies
    if (Object.keys(gasOraclesViolation.actual).length > 0) {
      this.addViolation(gasOraclesViolation);
    }

    const actualBeneficiary = await igp.beneficiary();
    const expectedBeneficiary = this.configMap[local].beneficiary;
    if (!eqAddress(actualBeneficiary, expectedBeneficiary)) {
      const violation: IgpBeneficiaryViolation = {
        type: 'InterchainGasPaymaster',
        subType: IgpViolationType.Beneficiary,
        contract: igp,
        chain: local,
        actual: actualBeneficiary,
        expected: expectedBeneficiary,
      };
      this.addViolation(violation);
    }
  }

  getGasOracleAddress(local: ChainName, remote: ChainName): Address {
    const config = this.configMap[local];
    const gasOracleType = config.gasOracleType[remote];
    if (!gasOracleType) {
      this.app.logger(
        `No gas oracle for local ${local} and remote ${remote}, defaulting to zero address`,
      );
      return ethers.constants.AddressZero;
    }
    const coreContracts = this.app.getContracts(local);
    switch (gasOracleType) {
      case GasOracleContractType.StorageGasOracle:
        return coreContracts.storageGasOracle.address;
      default:
        throw Error(`Unsupported gas oracle type ${gasOracleType}`);
    }
  }
}
