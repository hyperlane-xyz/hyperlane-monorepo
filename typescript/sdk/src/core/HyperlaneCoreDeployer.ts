import debug from 'debug';
import { ethers } from 'ethers';

import {
  Mailbox,
  TimelockController,
  TimelockController__factory,
  ValidatorAnnounce,
} from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import {
  HyperlaneIsmFactory,
  moduleMatchesConfig,
} from '../ism/HyperlaneIsmFactory';
import { IsmConfig } from '../ism/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { CoreFactories, coreFactories } from './contracts';
import { CoreConfig } from './types';

export class HyperlaneCoreDeployer extends HyperlaneDeployer<
  CoreConfig,
  CoreFactories
> {
  startingBlockNumbers: ChainMap<number | undefined> = {};

  constructor(
    multiProvider: MultiProvider,
    readonly ismFactory: HyperlaneIsmFactory,
  ) {
    super(multiProvider, coreFactories, {
      logger: debug('hyperlane:CoreDeployer'),
      chainTimeoutMs: 1000 * 60 * 10, // 10 minutes
    });
  }

  async deployTimelock(
    chain: ChainName,
    delay: number,
    owner: types.Address,
  ): Promise<TimelockController> {
    const timelock = await this.deployContract(
      chain,
      'timelockController',
      // see https://docs.openzeppelin.com/contracts/4.x/api/governance#TimelockController-constructor-uint256-address---address---address-
      // delay, [proposers], [executors], admin
      [delay, [owner], [owner], ethers.constants.AddressZero],
    );
    return timelock;
  }

  async deployMailbox(
    chain: ChainName,
    defaultIsmAddress: types.Address,
    proxyAdmin: types.Address,
    owner: types.Address,
  ): Promise<Mailbox> {
    const domain = this.multiProvider.getDomainId(chain);

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

  async deployIsm(chain: ChainName, config: IsmConfig): Promise<types.Address> {
    const cachedMailbox = this.deployedContracts[chain]?.mailbox;
    if (cachedMailbox) {
      const module = await cachedMailbox.defaultIsm();
      if (
        await moduleMatchesConfig(
          chain,
          module,
          config,
          this.ismFactory.multiProvider,
          this.ismFactory.getContracts(chain),
        )
      ) {
        this.logger(`Default ISM matches config for ${chain}`);
        return module;
      }
    }
    this.logger(`Deploying new ISM to ${chain}`);
    const ism = await this.ismFactory.deploy(chain, config);
    return ism.address;
  }

  async deployContracts(
    chain: ChainName,
    config: CoreConfig,
  ): Promise<HyperlaneContracts<CoreFactories>> {
    if (config.remove) {
      // skip deploying to chains configured to be removed
      return undefined as any;
    }

    this.startingBlockNumbers[chain] = await this.multiProvider
      .getProvider(chain)
      .getBlockNumber();

    const ism = await this.deployIsm(chain, config.defaultIsm);
    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);

    const mailbox = await this.deployMailbox(
      chain,
      ism,
      proxyAdmin.address,
      config.owner,
    );
    const validatorAnnounce = await this.deployValidatorAnnounce(
      chain,
      mailbox.address,
    );

    let timelockController: TimelockController;
    if (config.upgradeTimelockDelay) {
      timelockController = await this.deployTimelock(
        chain,
        config.upgradeTimelockDelay,
        config.owner,
      );
      await this.transferOwnershipOfContracts(
        chain,
        timelockController.address,
        { proxyAdmin },
      );
      await this.transferOwnershipOfContracts(chain, config.owner, { mailbox });
    } else {
      // mock this for consistent serialization
      timelockController = TimelockController__factory.connect(
        ethers.constants.AddressZero,
        this.multiProvider.getProvider(chain),
      );
      await this.transferOwnershipOfContracts(chain, config.owner, {
        mailbox,
        proxyAdmin,
      });
    }

    return {
      mailbox,
      proxyAdmin,
      timelockController,
      validatorAnnounce,
    };
  }
}
