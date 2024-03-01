import debug from 'debug';
import { ethers } from 'ethers';

import {
  IPostDispatchHook,
  Mailbox,
  TestRecipient,
  ValidatorAnnounce,
} from '@hyperlane-xyz/core';
import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import {
  DeployerOptions,
  HyperlaneDeployer,
} from '../deploy/HyperlaneDeployer';
import { HyperlaneHookDeployer } from '../hook/HyperlaneHookDeployer';
import { HookConfig } from '../hook/types';
import { IsmConfig } from '../ism/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { TestRecipientDeployer } from './TestRecipientDeployer';
import { CoreAddresses, CoreFactories, coreFactories } from './contracts';
import { CoreConfig } from './types';

export class HyperlaneCoreDeployer extends HyperlaneDeployer<
  CoreConfig,
  CoreFactories
> {
  hookDeployer: HyperlaneHookDeployer;
  testRecipientDeployer: TestRecipientDeployer;

  constructor(multiProvider: MultiProvider, options: DeployerOptions) {
    super(multiProvider, coreFactories, {
      logger: debug('hyperlane:CoreDeployer'),
      chainTimeoutMs: 1000 * 60 * 10, // 10 minutes
      ...options,
    });
    this.hookDeployer = new HyperlaneHookDeployer(multiProvider, {}, options);
    this.testRecipientDeployer = new TestRecipientDeployer(
      multiProvider,
      options,
    );
  }

  cacheAddressesMap(addressesMap: ChainMap<CoreAddresses>): void {
    this.hookDeployer.cacheAddressesMap(addressesMap);
    super.cacheAddressesMap(addressesMap);
  }

  async deployMailbox(
    chain: ChainName,
    config: CoreConfig,
    proxyAdmin: Address,
  ): Promise<Mailbox> {
    const domain = this.multiProvider.getDomainId(chain);
    const mailbox = await this.deployProxiedContract(
      chain,
      'mailbox',
      proxyAdmin,
      [domain],
    );

    let defaultIsm = await mailbox.defaultIsm();
    if (eqAddress(defaultIsm, ethers.constants.AddressZero)) {
      this.logger('Deploying default ISM');
      defaultIsm = await this.deployIsm(
        chain,
        config.defaultIsm,
        mailbox.address,
      );
    }

    const hookAddresses = { mailbox: mailbox.address, proxyAdmin };

    this.logger('Deploying default hook');
    const defaultHook = await this.deployHook(
      chain,
      config.defaultHook,
      hookAddresses,
    );

    this.logger('Deploying required hook');
    const requiredHook = await this.deployHook(
      chain,
      config.requiredHook,
      hookAddresses,
    );

    // configure mailbox
    try {
      this.logger('Initializing mailbox');
      await this.multiProvider.handleTx(
        chain,
        mailbox.initialize(
          config.owner,
          defaultIsm,
          defaultHook.address,
          requiredHook.address,
          this.multiProvider.getTransactionOverrides(chain),
        ),
      );
    } catch (e: any) {
      if (
        !e.message.includes('already initialized') &&
        // Some RPC providers dont return the revert reason (nor allow ethers to parse it), so we have to check the message
        !e.message.includes('Reverted 0x08c379a') &&
        // Handle situation where the gas estimation fails on the call function,
        // then the real error reason is not available in `e.message`, but rather in `e.error.reason`
        !e.error?.reason?.includes('already initialized')
      ) {
        throw e;
      }

      this.logger('Mailbox already initialized');

      await this.configureHook(
        chain,
        mailbox,
        defaultHook.address,
        (_mailbox) => _mailbox.defaultHook(),
        (_mailbox, _hook) => _mailbox.populateTransaction.setDefaultHook(_hook),
      );

      await this.configureHook(
        chain,
        mailbox,
        requiredHook.address,
        (_mailbox) => _mailbox.requiredHook(),
        (_mailbox, _hook) =>
          _mailbox.populateTransaction.setRequiredHook(_hook),
      );

      await this.configureIsm(
        chain,
        mailbox,
        config.defaultIsm,
        (_mailbox) => _mailbox.defaultIsm(),
        (_mailbox, _module) =>
          _mailbox.populateTransaction.setDefaultIsm(_module),
      );
    }

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

  async deployHook(
    chain: ChainName,
    config: HookConfig,
    coreAddresses: Partial<CoreAddresses>,
  ): Promise<IPostDispatchHook> {
    const hooks = await this.hookDeployer.deployContracts(
      chain,
      config,
      coreAddresses,
    );
    this.addDeployedContracts(
      chain,
      this.hookDeployer.deployedContracts[chain],
      this.hookDeployer.verificationInputs[chain],
    );
    return hooks[config.type];
  }

  async deployIsm(
    chain: ChainName,
    config: IsmConfig,
    mailbox: Address,
  ): Promise<Address> {
    if (typeof config === 'string') {
      return config;
    }

    if (!this.options.ismFactory) {
      throw new Error('ISM factory not provided');
    }

    this.options.ismFactory.setDeployer(this);
    const ism = await this.options.ismFactory.deploy({
      destination: chain,
      config,
      mailbox,
    });
    this.addDeployedContracts(
      chain,
      this.options.ismFactory.deployedIsms[chain],
    );
    return ism.address;
  }

  async deployTestRecipient(chain: ChainName): Promise<TestRecipient> {
    const contracts = await this.testRecipientDeployer.deployContracts(
      chain,
      {}, // use default ISM from core deployer entrypoint
    );
    this.addDeployedContracts(chain, contracts);
    return contracts.testRecipient;
  }

  async deployContracts(
    chain: ChainName,
    config: CoreConfig,
  ): Promise<HyperlaneContracts<CoreFactories>> {
    if (config.remove) {
      // skip deploying to chains configured to be removed
      return undefined as any;
    }

    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);

    const mailbox = await this.deployMailbox(chain, config, proxyAdmin.address);

    const validatorAnnounce = await this.deployValidatorAnnounce(
      chain,
      mailbox.address,
    );

    if (config.upgrade) {
      const timelockController = await this.deployTimelock(
        chain,
        config.upgrade.timelock,
      );
      config.ownerOverrides = {
        ...config.ownerOverrides,
        proxyAdmin: timelockController.address,
      };
    }

    this.logger('Deploying test recipient');

    const testRecipient = await this.deployTestRecipient(chain);

    const contracts = {
      mailbox,
      proxyAdmin,
      validatorAnnounce,
      testRecipient,
    };

    await this.transferOwnershipOfContracts(chain, config, contracts);

    return contracts;
  }
}
