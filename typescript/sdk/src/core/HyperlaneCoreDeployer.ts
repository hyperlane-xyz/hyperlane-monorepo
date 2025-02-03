import {
  IPostDispatchHook,
  IPostDispatchHook__factory,
  Mailbox,
  Mailbox__factory,
  TestRecipient,
  TestRecipient__factory,
  ValidatorAnnounce,
} from '@hyperlane-xyz/core';
import { Address, isZeroishAddress, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { HyperlaneHookDeployer } from '../hook/HyperlaneHookDeployer.js';
import { HookConfig } from '../hook/types.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { IsmConfig } from '../ism/types.js';
import { moduleMatchesConfig } from '../ism/utils.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../types.js';

import { TestRecipientDeployer } from './TestRecipientDeployer.js';
import { CoreAddresses, CoreFactories, coreFactories } from './contracts.js';
import { CoreConfig, DeployedCoreAddresses } from './types.js';

export class HyperlaneCoreDeployer extends HyperlaneDeployer<
  CoreConfig,
  CoreFactories
> {
  hookDeployer: HyperlaneHookDeployer;
  testRecipient: TestRecipientDeployer;
  protected _cachedAddresses: Record<string, any> = {};

  constructor(
    multiProvider: MultiProvider,
    readonly ismFactory: HyperlaneIsmFactory,
    contractVerifier?: ContractVerifier,
    concurrentDeploy: boolean = false,
    chainTimeoutMs: number = 1000 * 60 * 10, // 10 minutes
    private existingAddresses?: DeployedCoreAddresses,
    private deploymentPlan?: Record<keyof DeployedCoreAddresses, boolean>,
  ) {
    super(multiProvider, coreFactories, {
      logger: rootLogger.child({ module: 'CoreDeployer' }),
      chainTimeoutMs,
      ismFactory,
      contractVerifier,
      concurrentDeploy,
    });
    this.hookDeployer = new HyperlaneHookDeployer(
      multiProvider,
      {},
      ismFactory,
      contractVerifier,
      concurrentDeploy,
    );
    this.testRecipient = new TestRecipientDeployer(
      multiProvider,
      contractVerifier,
      concurrentDeploy,
    );
    // Initialize with existing addresses if in fix mode
    if (existingAddresses) {
      this._cachedAddresses = existingAddresses;
    }
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

    // In fix mode, check if mailbox already exists
    if (this.existingAddresses?.mailbox) {
      this.logger.debug(
        `Using existing mailbox at ${this.existingAddresses.mailbox}`,
      );
      return Mailbox__factory.connect(
        this.existingAddresses.mailbox,
        this.multiProvider.getProvider(chain),
      );
    }

    const mailbox = await this.deployProxiedContract(
      chain,
      'mailbox',
      'mailbox',
      proxyAdmin,
      [domain],
    );

    let defaultIsm = await mailbox.defaultIsm();
    const matches = await moduleMatchesConfig(
      chain,
      defaultIsm,
      config.defaultIsm,
      this.multiProvider,
      this.ismFactory.getContracts(chain),
    );
    if (!matches) {
      this.logger.debug('Deploying default ISM');
      defaultIsm = await this.deployIsm(
        chain,
        config.defaultIsm,
        mailbox.address,
      );
    }
    this._cachedAddresses[chain] = this._cachedAddresses[chain] || {};
    this._cachedAddresses[chain].interchainSecurityModule = defaultIsm;

    const hookAddresses = { mailbox: mailbox.address, proxyAdmin };

    this.logger.debug('Deploying default hook');
    const defaultHook = await this.deployHook(
      chain,
      config.defaultHook,
      hookAddresses,
    );

    this.logger.debug('Deploying required hook');
    const requiredHook = await this.deployHook(
      chain,
      config.requiredHook,
      hookAddresses,
    );

    const txOverrides = this.multiProvider.getTransactionOverrides(chain);

    // Check if the mailbox has already been initialized
    const currentDefaultIsm = await mailbox.defaultIsm();
    if (isZeroishAddress(currentDefaultIsm)) {
      // If the default ISM is the zero address, the mailbox hasn't been initialized
      this.logger.debug('Initializing mailbox');
      try {
        await this.multiProvider.handleTx(
          chain,
          mailbox.initialize(
            config.owner,
            defaultIsm,
            defaultHook.address,
            requiredHook.address,
            txOverrides,
          ),
        );
      } catch (e: any) {
        // If we still get an error here, it's likely a genuine error
        this.logger.error('Failed to initialize mailbox:', e);
        throw e;
      }
    } else {
      // If the default ISM is not the zero address, the mailbox has likely been initialized
      this.logger.debug('Mailbox appears to be already initialized');
    }

    await this.configureHook(
      chain,
      mailbox,
      defaultHook.address,
      (_mailbox) => _mailbox.defaultHook(),
      (_mailbox, _hook) =>
        _mailbox.populateTransaction.setDefaultHook(_hook, { ...txOverrides }),
    );

    await this.configureHook(
      chain,
      mailbox,
      requiredHook.address,
      (_mailbox) => _mailbox.requiredHook(),
      (_mailbox, _hook) =>
        _mailbox.populateTransaction.setRequiredHook(_hook, { ...txOverrides }),
    );

    await this.configureIsm(
      chain,
      mailbox,
      defaultIsm,
      (_mailbox) => _mailbox.defaultIsm(),
      (_mailbox, _module) =>
        _mailbox.populateTransaction.setDefaultIsm(_module),
    );

    return mailbox;
  }

  async deployValidatorAnnounce(
    chain: ChainName,
    mailboxAddress: string,
  ): Promise<ValidatorAnnounce> {
    // In fix mode, check if validator announce already exists
    if (this.existingAddresses?.validatorAnnounce) {
      this.logger.debug(
        `Using existing validator announce at ${this.existingAddresses.validatorAnnounce}`,
      );
      return this.factories.validatorAnnounce.attach(
        this.existingAddresses.validatorAnnounce,
      );
    }

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
    if (typeof config === 'string') {
      return IPostDispatchHook__factory.connect(
        config,
        this.multiProvider.getProvider(chain),
      );
    }

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
    if (typeof config === 'string') {
      return Object.values(hooks)[0];
    } else {
      return hooks[config.type];
    }
  }

  async deployIsm(
    chain: ChainName,
    config: IsmConfig,
    mailbox: Address,
  ): Promise<Address> {
    const ism = await this.ismFactory.deploy({
      destination: chain,
      config,
      mailbox,
    });
    this.addDeployedContracts(chain, this.ismFactory.deployedIsms[chain]);
    return ism.address;
  }

  async deployTestRecipient(
    chain: ChainName,
    interchainSecurityModule?: IsmConfig,
  ): Promise<TestRecipient> {
    // In fix mode, check if test recipient already exists
    if (this.existingAddresses?.testRecipient) {
      this.logger.debug(
        `Using existing test recipient at ${this.existingAddresses.testRecipient}`,
      );
      return TestRecipient__factory.connect(
        this.existingAddresses.testRecipient,
        this.multiProvider.getProvider(chain),
      );
    }

    const testRecipient = await this.testRecipient.deployContracts(chain, {
      interchainSecurityModule,
    });
    this.addDeployedContracts(chain, testRecipient);
    return testRecipient.testRecipient;
  }

  async deployContracts(
    chain: ChainName,
    config: CoreConfig,
  ): Promise<HyperlaneContracts<CoreFactories>> {
    const contracts: Partial<HyperlaneContracts<CoreFactories>> = {};

    // Only deploy contracts that don't exist in fix mode or are marked for deployment in the plan
    if (
      !this.existingAddresses?.proxyAdmin ||
      this.deploymentPlan?.proxyAdmin
    ) {
      contracts.proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);
    }

    if (!this.existingAddresses?.mailbox || this.deploymentPlan?.mailbox) {
      contracts.mailbox = await this.deployMailbox(
        chain,
        config,
        contracts.proxyAdmin?.address ||
          this.existingAddresses?.proxyAdmin ||
          '',
      );
    }

    if (
      !this.existingAddresses?.validatorAnnounce ||
      this.deploymentPlan?.validatorAnnounce
    ) {
      contracts.validatorAnnounce = await this.deployValidatorAnnounce(
        chain,
        contracts.mailbox?.address || this.existingAddresses?.mailbox || '',
      );
    }

    if (
      !this.existingAddresses?.testRecipient ||
      this.deploymentPlan?.testRecipient
    ) {
      const testRecipient = await this.deployTestRecipient(
        chain,
        this._cachedAddresses[chain]?.interchainSecurityModule,
      );
      (contracts as any).testRecipient = testRecipient;
    }

    return {
      ...this.existingAddresses,
      ...contracts,
    } as HyperlaneContracts<CoreFactories>;
  }
}
