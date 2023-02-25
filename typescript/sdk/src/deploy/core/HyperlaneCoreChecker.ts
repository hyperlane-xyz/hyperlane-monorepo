import { defaultAbiCoder } from 'ethers/lib/utils';

import { types, utils } from '@hyperlane-xyz/utils';
import { eqAddress } from '@hyperlane-xyz/utils/dist/src/utils';

import { HyperlaneCore } from '../../core/HyperlaneCore';
import { ChainNameToDomainId } from '../../domains';
import { ChainName } from '../../types';
import { HyperlaneAppChecker } from '../HyperlaneAppChecker';

import {
  CoreConfig,
  CoreViolationType,
  EnrolledValidatorsViolation,
  GasOracleContractType,
  IgpBeneficiaryViolation,
  IgpGasOraclesViolation,
  IgpViolationType,
  MailboxViolation,
  MailboxViolationType,
  MultisigIsmViolationType,
  ThresholdViolation,
  ValidatorAnnounceViolation,
} from './types';

const MAILBOX_WITHOUT_LOCAL_DOMAIN_BYTE_CODE_HASH =
  '0x29b7294ab3ad2e8587e5cce0e2289ce65e12a2ea2f1e7ab34a05e7737616f457';
const TRANSPARENT_PROXY_BYTECODE_HASH =
  '0x4dde3d0906b6492bf1d4947f667afe8d53c8899f1d8788cabafd082938dceb2d';
const MULTISIG_ISM_BYTECODE_HASH =
  '0x5565704ffa5b10fdf37d57abfddcf137101d5fb418ded21fa6c5f90262c57dc2';
const PROXY_ADMIN_BYTECODE_HASH =
  '0x7c378e9d49408861ca754fe684b9f7d1ea525bddf095ee0463902df701453ba0';
const INTERCHAIN_GAS_PAYMASTER_BYTECODE_HASH =
  '0xcee48ab556ae2ff12b6458fa92e5e31f4a07f7852a0ed06e43a7f06f3c4c6d76';
const OVERHEAD_IGP_BYTECODE_HASH =
  '0x3cfed1f24f1e9b28a76d5a8c61696a04f7bc474404b823a2fcc210ea52346252';
export class HyperlaneCoreChecker<
  Chain extends ChainName,
> extends HyperlaneAppChecker<Chain, HyperlaneCore<Chain>, CoreConfig> {
  async checkChain(chain: Chain): Promise<void> {
    const config = this.configMap[chain];
    // skip chains that are configured to be removed
    if (config.remove) {
      return;
    }

    await this.checkDomainOwnership(chain);
    await this.checkProxiedContracts(chain);
    await this.checkMailbox(chain);
    await this.checkMultisigIsm(chain);
    await this.checkBytecodes(chain);
    await this.checkValidatorAnnounce(chain);
    await this.checkInterchainGasPaymaster(chain);
  }

  async checkDomainOwnership(chain: Chain): Promise<void> {
    const config = this.configMap[chain];
    if (config.owner) {
      const contracts = this.app.getContracts(chain);
      const ownables = [
        contracts.proxyAdmin,
        contracts.mailbox.contract,
        contracts.multisigIsm,
      ];
      return this.checkOwnership(chain, config.owner, ownables);
    }
  }

  async checkMailbox(chain: Chain): Promise<void> {
    const contracts = this.app.getContracts(chain);
    const mailbox = contracts.mailbox.contract;
    const localDomain = await mailbox.localDomain();
    utils.assert(localDomain === ChainNameToDomainId[chain]);

    const actualIsm = await mailbox.defaultIsm();
    const expectedIsm = contracts.multisigIsm.address;
    if (actualIsm !== expectedIsm) {
      const violation: MailboxViolation = {
        type: CoreViolationType.Mailbox,
        mailboxType: MailboxViolationType.DefaultIsm,
        contract: mailbox,
        chain,
        actual: actualIsm,
        expected: expectedIsm,
      };
      this.addViolation(violation);
    }
  }

  async checkBytecodes(chain: Chain): Promise<void> {
    const contracts = this.app.getContracts(chain);
    const mailbox = contracts.mailbox.contract;
    const localDomain = await mailbox.localDomain();

    await this.checkBytecode(
      chain,
      'Mailbox implementation',
      contracts.mailbox.addresses.implementation,
      MAILBOX_WITHOUT_LOCAL_DOMAIN_BYTE_CODE_HASH,
      (_) =>
        // This is obviously super janky but basically we are searching
        //  for the ocurrences of localDomain in the bytecode and remove
        //  that to compare, but some coincidental ocurrences of
        // localDomain in the bytecode should be not be removed which
        // are just done via an offset guard
        _.replaceAll(
          defaultAbiCoder.encode(['uint32'], [localDomain]).slice(2),
          (match, offset) => (offset > 8000 ? match : ''),
        ),
    );

    await this.checkBytecode(
      chain,
      'Mailbox proxy',
      contracts.mailbox.address,
      TRANSPARENT_PROXY_BYTECODE_HASH,
    );
    await this.checkBytecode(
      chain,
      'InterchainGasPaymaster proxy',
      contracts.interchainGasPaymaster.address,
      TRANSPARENT_PROXY_BYTECODE_HASH,
    );
    await this.checkBytecode(
      chain,
      'ProxyAdmin',
      contracts.proxyAdmin.address,
      PROXY_ADMIN_BYTECODE_HASH,
    );
    await this.checkBytecode(
      chain,
      'MultisigIsm implementation',
      contracts.multisigIsm.address,
      MULTISIG_ISM_BYTECODE_HASH,
    );
    await this.checkBytecode(
      chain,
      'InterchainGasPaymaster implementation',
      contracts.interchainGasPaymaster.addresses.implementation,
      INTERCHAIN_GAS_PAYMASTER_BYTECODE_HASH,
    );

    await this.checkBytecode(
      chain,
      'OverheadIGP',
      contracts.defaultIsmInterchainGasPaymaster.address,
      OVERHEAD_IGP_BYTECODE_HASH,
      (_) =>
        // Remove the address of the wrapped ISM from the bytecode
        _.replaceAll(
          defaultAbiCoder
            .encode(
              ['address'],
              [contracts.interchainGasPaymaster.addresses.proxy],
            )
            .slice(2),
          '',
        ),
    );
  }

  async checkProxiedContracts(chain: Chain): Promise<void> {
    const contracts = this.app.getContracts(chain);
    await this.checkProxiedContract(
      chain,
      'Mailbox',
      contracts.mailbox.addresses,
      contracts.proxyAdmin.address,
    );
    await this.checkProxiedContract(
      chain,
      'InterchainGasPaymaster',
      contracts.interchainGasPaymaster.addresses,
      contracts.proxyAdmin.address,
    );
  }

  async checkValidatorAnnounce(chain: Chain): Promise<void> {
    const expectedValidators = this.configMap[chain].multisigIsm.validators;
    const validatorAnnounce = this.app.getContracts(chain).validatorAnnounce;
    const announcedValidators =
      await validatorAnnounce.getAnnouncedValidators();
    expectedValidators.map((validator) => {
      const matches = announcedValidators.filter((x) =>
        eqAddress(x, validator),
      );
      if (matches.length == 0) {
        const violation: ValidatorAnnounceViolation = {
          type: CoreViolationType.ValidatorAnnounce,
          chain,
          validator,
          actual: false,
          expected: true,
        };
        this.addViolation(violation);
      }
    });
  }

  async checkMultisigIsm(local: Chain): Promise<void> {
    await Promise.all(
      this.app
        .remoteChains(local)
        .map((remote) => this.checkMultisigIsmForRemote(local, remote)),
    );
  }

  async checkMultisigIsmForRemote(local: Chain, remote: Chain): Promise<void> {
    const coreContracts = this.app.getContracts(local);
    const multisigIsm = coreContracts.multisigIsm;
    const config = this.configMap[remote];

    const remoteDomain = ChainNameToDomainId[remote];
    const multisigIsmConfig = config.multisigIsm;
    const expectedValidators = multisigIsmConfig.validators;
    const actualValidators = await multisigIsm.validators(remoteDomain);

    const expectedSet = new Set<string>(
      expectedValidators.map((_) => _.toLowerCase()),
    );
    const actualSet = new Set<string>(
      actualValidators.map((_) => _.toLowerCase()),
    );

    if (!utils.setEquality(expectedSet, actualSet)) {
      const violation: EnrolledValidatorsViolation = {
        type: CoreViolationType.MultisigIsm,
        subType: MultisigIsmViolationType.EnrolledValidators,
        contract: multisigIsm,
        chain: local,
        remote,
        actual: actualSet,
        expected: expectedSet,
      };
      this.addViolation(violation);
    }

    const expectedThreshold = multisigIsmConfig.threshold;
    utils.assert(expectedThreshold !== undefined);

    const actualThreshold = await multisigIsm.threshold(remoteDomain);

    if (expectedThreshold !== actualThreshold) {
      const violation: ThresholdViolation = {
        type: CoreViolationType.MultisigIsm,
        subType: MultisigIsmViolationType.Threshold,
        contract: multisigIsm,
        chain: local,
        remote,
        actual: actualThreshold,
        expected: expectedThreshold,
      };
      this.addViolation(violation);
    }
  }

  async checkInterchainGasPaymaster(local: Chain): Promise<void> {
    const coreContracts = this.app.getContracts(local);
    const igp = coreContracts.interchainGasPaymaster.contract;

    // Construct the violation, updating the actual & expected
    // objects as violations are found.
    // A single violation is used so that only a single `setGasOracles`
    // call is generated to set multiple gas oracles.
    const gasOraclesViolation: IgpGasOraclesViolation = {
      type: CoreViolationType.InterchainGasPaymaster,
      subType: IgpViolationType.GasOracles,
      contract: igp,
      chain: local,
      actual: {},
      expected: {},
    };

    const remotes = this.multiProvider.remoteChains(local);
    for (const remote of remotes) {
      const remoteId = ChainNameToDomainId[remote];
      const actualGasOracle = await igp.gasOracles(remoteId);
      const expectedGasOracle = this.getGasOracleAddress(local, remote);

      if (!utils.eqAddress(actualGasOracle, expectedGasOracle)) {
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
    const expectedBeneficiary = this.configMap[local].igp.beneficiary;
    if (!utils.eqAddress(actualBeneficiary, expectedBeneficiary)) {
      const violation: IgpBeneficiaryViolation = {
        type: CoreViolationType.InterchainGasPaymaster,
        subType: IgpViolationType.Beneficiary,
        contract: igp,
        chain: local,
        actual: actualBeneficiary,
        expected: expectedBeneficiary,
      };
      this.addViolation(violation);
    }
  }

  getGasOracleAddress(local: Chain, remote: Chain): types.Address {
    const config = this.configMap[local];
    const gasOracleType = config.igp.gasOracles[remote];
    if (!gasOracleType) {
      throw Error(
        `Expected gas oracle type for local ${local} and remote ${remote}`,
      );
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
