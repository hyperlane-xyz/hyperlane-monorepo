import { BigNumber } from 'ethers';

import { eqAddress } from '@hyperlane-xyz/utils';

import { BytecodeHash } from '../consts/bytecode.js';
import { chainMetadata } from '../consts/chainMetadata.js';
import { HyperlaneAppChecker } from '../deploy/HyperlaneAppChecker.js';
import { proxyImplementation } from '../deploy/proxy.js';
import { ChainName } from '../types.js';

import { HyperlaneIgp } from './HyperlaneIgp.js';
import {
  IgpBeneficiaryViolation,
  IgpConfig,
  IgpGasOraclesViolation,
  IgpOverheadViolation,
  IgpViolationType,
} from './types.js';

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
    await super.checkOwnership(chain, config.owner, config.ownerOverrides);
  }

  async checkBytecodes(chain: ChainName): Promise<void> {
    const contracts = this.app.getContracts(chain);
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
        BytecodeHash.OPT_INTERCHAIN_GAS_PAYMASTER_BYTECODE_HASH,
      ],
      (bytecode) =>
        bytecode // We persist the block number in the bytecode now too, so we have to strip it
          .replaceAll(
            /(00000000000000000000000000000000000000000000000000000000[a-f0-9]{0,22})81565/g,
            (match, _offset) => (match.length % 2 === 0 ? '' : '0'),
          ),
    );

    await this.checkProxy(
      chain,
      'InterchainGasPaymaster proxy',
      contracts.interchainGasPaymaster.address,
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

    const remotes = await this.app.remoteChains(local);
    for (const remote of remotes) {
      let expectedOverhead = this.configMap[local].overhead[remote];
      if (!expectedOverhead) {
        this.app.logger.debug(
          `No overhead configured for ${local} -> ${remote}, defaulting to 0`,
        );
        expectedOverhead = 0;
      }

      const remoteId =
        chainMetadata[remote]?.domainId ??
        this.multiProvider.getDomainId(remote);
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

    const remotes = new Set(
      Object.keys(this.configMap[local].oracleConfig ?? {}),
    );
    for (const remote of remotes) {
      const remoteId =
        chainMetadata[remote]?.domainId ??
        this.multiProvider.getDomainId(remote);
      const destinationGasConfigs = await igp.destinationGasConfigs(remoteId);
      const actualGasOracle = destinationGasConfigs.gasOracle;
      const expectedGasOracle = coreContracts.storageGasOracle.address;

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
}
