import {
  IPostDispatchHook,
  IPostDispatchHook__factory,
  Mailbox,
  TestRecipient,
  ValidatorAnnounce,
} from '@hyperlane-xyz/core';
import {
  Address,
  addBufferToGasLimit,
  isZeroishAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

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
import { CoreConfig } from './types.js';

export class HyperlaneCoreDeployer extends HyperlaneDeployer<
  CoreConfig,
  CoreFactories
> {
  hookDeployer: HyperlaneHookDeployer;
  testRecipient: TestRecipientDeployer;

  constructor(
    multiProvider: MultiProvider,
    readonly ismFactory: HyperlaneIsmFactory,
    contractVerifier?: ContractVerifier,
    concurrentDeploy: boolean = false,
    chainTimeoutMs: number = 1000 * 60 * 10, // 10 minutes
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
  }

  cacheAddressesMap(addressesMap: ChainMap<CoreAddresses>): void {
    this.hookDeployer.cacheAddressesMap(addressesMap);
    this.testRecipient.cacheAddressesMap(addressesMap);
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
    this.cachedAddresses[chain].interchainSecurityModule = defaultIsm;

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
        const estimatedGas = await mailbox.estimateGas.initialize(
          config.owner,
          defaultIsm,
          defaultHook.address,
          requiredHook.address,
        );
        await this.multiProvider.handleTx(
          chain,
          mailbox.initialize(
            config.owner,
            defaultIsm,
            defaultHook.address,
            requiredHook.address,
            {
              gasLimit: addBufferToGasLimit(estimatedGas),
              ...txOverrides,
            },
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

    const testRecipient = await this.deployTestRecipient(
      chain,
      this.cachedAddresses[chain].interchainSecurityModule,
    );

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
