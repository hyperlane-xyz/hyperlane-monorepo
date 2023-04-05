import debug from 'debug';
import { ethers } from 'ethers';

import {
  LegacyMultisigIsm,
  Mailbox,
  Ownable,
  ValidatorAnnounce,
} from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';
import { objMap } from '../utils/objects';

import { CoreFactories, coreFactories } from './contracts';
import { CoreConfig } from './types';

export class HyperlaneCoreDeployer extends HyperlaneDeployer<
  CoreConfig,
  CoreFactories
> {
  startingBlockNumbers: ChainMap<number | undefined>;

  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<CoreConfig>,
    factoriesOverride = coreFactories,
  ) {
    super(multiProvider, configMap, factoriesOverride, {
      logger: debug('hyperlane:CoreDeployer'),
    });
    this.startingBlockNumbers = objMap(configMap, () => undefined);
  }

  async deployMailbox(
    chain: ChainName,
    defaultIsmAddress: types.Address,
    proxyAdmin: types.Address,
  ): Promise<Mailbox> {
    const domain = this.multiProvider.getDomainId(chain);
    const owner = this.configMap[chain].owner;

    const mailbox = await this.deployProxiedContract(
      chain,
      'mailbox',
      proxyAdmin,
      [domain],
      [owner, defaultIsmAddress],
    );
    return mailbox;
  }

  async deployValidatorAnnounce(
    chain: ChainName,
    mailboxAddress: string,
  ): Promise<ValidatorAnnounce> {
    const validatorAnnounce = await this.deployContract(
      chain,
      'validatorAnnounce',
      [mailboxAddress],
    );
    return validatorAnnounce;
  }

  async deployLegacyMultisigIsm(chain: ChainName): Promise<LegacyMultisigIsm> {
    const multisigIsm = await this.deployContract(chain, 'multisigIsm', []);
    const remotes = Object.keys(this.configMap[chain].multisigIsm);
    const overrides = this.multiProvider.getTransactionOverrides(chain);

    await super.runIfOwner(chain, multisigIsm, async () => {
      // TODO: Remove extraneous validators
      const remoteDomains = this.multiProvider.getDomainIds(remotes);
      const actualValidators = await Promise.all(
        remoteDomains.map((id) => multisigIsm.validators(id)),
      );
      const expectedValidators = remotes.map(
        (remote) => this.configMap[chain].multisigIsm[remote].validators,
      );
      const validatorsToEnroll = expectedValidators.map((validators, i) =>
        validators.filter(
          (validator) =>
            !actualValidators[i].includes(ethers.utils.getAddress(validator)),
        ),
      );
      const chainsToEnrollValidators = remotes.filter(
        (_, i) => validatorsToEnroll[i].length > 0,
      );
      if (chainsToEnrollValidators.length > 0) {
        this.logger(
          `Enroll ${chainsToEnrollValidators} validators on ${chain}`,
        );
        await this.multiProvider.handleTx(
          chain,
          multisigIsm.enrollValidators(
            chainsToEnrollValidators.map((c) =>
              this.multiProvider.getDomainId(c),
            ),
            validatorsToEnroll.filter((validators) => validators.length > 0),
            overrides,
          ),
        );
      }
      const actualThresholds = await Promise.all(
        remoteDomains.map((id) => multisigIsm.threshold(id)),
      );
      const expectedThresholds = remotes.map(
        (remote) => this.configMap[chain].multisigIsm[remote].threshold,
      );
      const chainsToSetThreshold = remotes.filter(
        (_, i) => actualThresholds[i] !== expectedThresholds[i],
      );
      if (chainsToSetThreshold.length > 0) {
        this.logger(
          `Set remote (${chainsToSetThreshold}) thresholds on ${chain}`,
        );
        await this.multiProvider.handleTx(
          chain,
          multisigIsm.setThresholds(
            chainsToSetThreshold.map((c) => this.multiProvider.getDomainId(c)),
            chainsToSetThreshold.map(
              (remote) => this.configMap[chain].multisigIsm[remote].threshold,
            ),
            overrides,
          ),
        );
      }
    });
    return multisigIsm;
  }

  async deployContracts(
    chain: ChainName,
    config: CoreConfig,
  ): Promise<HyperlaneContracts<CoreFactories>> {
    if (config.remove) {
      // skip deploying to chains configured to be removed
      return undefined as any;
    }

    const provider = this.multiProvider.getProvider(chain);
    const startingBlockNumber = await provider.getBlockNumber();
    this.startingBlockNumbers[chain] = startingBlockNumber;
    const multisigIsm = await this.deployLegacyMultisigIsm(chain);

    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);

    const mailbox = await this.deployMailbox(
      chain,
      multisigIsm.address,
      proxyAdmin.address,
    );
    const validatorAnnounce = await this.deployValidatorAnnounce(
      chain,
      mailbox.address,
    );
    // Ownership of the Mailbox and the interchainGasPaymaster is transferred upon initialization.
    const ownables: Ownable[] = [multisigIsm, proxyAdmin];
    await this.transferOwnershipOfContracts(chain, config.owner, ownables);

    return {
      validatorAnnounce,
      proxyAdmin,
      mailbox,
      multisigIsm,
    };
  }
}
