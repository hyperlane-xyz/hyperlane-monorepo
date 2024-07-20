import {
  IPostDispatchHook,
  IPostDispatchHook__factory,
  Mailbox,
  TestRecipient,
  ValidatorAnnounce,
} from '@hyperlane-xyz/core';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

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
  ) {
    super(multiProvider, coreFactories, {
      logger: rootLogger.child({ module: 'CoreDeployer' }),
      chainTimeoutMs: 1000 * 60 * 10, // 10 minutes
      ismFactory,
      contractVerifier,
      concurrentDeploy,
    });
    this.hookDeployer = new HyperlaneHookDeployer(
      multiProvider,
      {},
      ismFactory,
      contractVerifier,
    );
    this.testRecipient = new TestRecipientDeployer(
      multiProvider,
      contractVerifier,
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

    // configure mailbox
    try {
      this.logger.debug('Initializing mailbox');
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
        !e.error?.reason?.includes('already initialized') &&
        // Some providers, like on Viction, return a generic error message for all revert reasons
        !e.message.includes('always failing transaction')
      ) {
        throw e;
      }

      this.logger.debug('Mailbox already initialized');

      const overrides = this.multiProvider.getTransactionOverrides(chain);
      await this.configureHook(
        chain,
        mailbox,
        defaultHook.address,
        (_mailbox) => _mailbox.defaultHook(),
        (_mailbox, _hook) =>
          _mailbox.populateTransaction.setDefaultHook(_hook, { ...overrides }),
      );

      await this.configureHook(
        chain,
        mailbox,
        requiredHook.address,
        (_mailbox) => _mailbox.requiredHook(),
        (_mailbox, _hook) =>
          _mailbox.populateTransaction.setRequiredHook(_hook, { ...overrides }),
      );

      await this.configureIsm(
        chain,
        mailbox,
        defaultIsm,
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
