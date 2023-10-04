import debug from 'debug';

import { Mailbox, ValidatorAnnounce } from '@hyperlane-xyz/core';
import { Address, objMap } from '@hyperlane-xyz/utils';

import { HyperlaneContracts, HyperlaneContractsMap } from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HyperlaneHookDeployer } from '../hook/HyperlaneHookDeployer';
import { HookFactories } from '../hook/contracts';
import { HookConfig } from '../hook/types';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
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
  deployedHooks: HyperlaneContractsMap<HookFactories> = {};

  constructor(
    multiProvider: MultiProvider,
    readonly ismFactory: HyperlaneIsmFactory,
    readonly hookDeployer = new HyperlaneHookDeployer(multiProvider, {}),
  ) {
    super(multiProvider, coreFactories, {
      logger: debug('hyperlane:CoreDeployer'),
      chainTimeoutMs: 1000 * 60 * 10, // 10 minutes
    });
  }

  async deployMailbox(
    chain: ChainName,
    proxyAdmin: Address,
    config: CoreConfig,
  ): Promise<Mailbox> {
    const cachedMailbox = this.readCache(
      chain,
      this.factories.mailbox,
      'mailbox',
    );

    if (cachedMailbox) {
      // let checker/governor handle cached mailbox default ISM configuration
      // TODO: check if config matches AND deployer is owner?
      return cachedMailbox;
    }

    const domain = this.multiProvider.getDomainId(chain);
    const mailbox = await this.deployProxiedContract(
      chain,
      'mailbox',
      proxyAdmin,
      [domain],
    );

    const defaultIsm = await this.deployIsm(chain, config.defaultIsm);
    const defaultHook = await this.deployHook(
      chain,
      config.defaultHook,
      mailbox.address,
    );
    const requiredHook = await this.deployHook(
      chain,
      config.requiredHook,
      mailbox.address,
    );

    // configure mailbox
    await this.multiProvider.handleTx(
      chain,
      mailbox.initialize(config.owner, defaultIsm, defaultHook, requiredHook),
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
    mailbox: Address,
  ): Promise<Address> {
    const hooks = await this.hookDeployer.deployContracts(
      chain,
      config,
      mailbox,
    );
    this.deployedHooks[chain] = {
      ...hooks,
      ...this.deployedHooks[chain],
    };
    return hooks[config.type].address;
  }

  async deployIsm(chain: ChainName, config: IsmConfig): Promise<Address> {
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

    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);

    const mailbox = await this.deployMailbox(chain, proxyAdmin.address, config);

    const deployedBlock = await mailbox.deployedBlock();
    this.startingBlockNumbers[chain] = deployedBlock.toNumber();

    const validatorAnnounce = await this.deployValidatorAnnounce(
      chain,
      mailbox.address,
    );

    let proxyOwner: string;
    if (config.upgrade) {
      const timelockController = await this.deployTimelock(
        chain,
        config.upgrade.timelock,
      );
      proxyOwner = timelockController.address;
    } else {
      proxyOwner = config.owner;
    }

    await this.transferOwnershipOfContracts(chain, proxyOwner, { proxyAdmin });

    return {
      mailbox,
      proxyAdmin,
      validatorAnnounce,
    };
  }

  async deploy(
    configMap: ChainMap<CoreConfig>,
  ): Promise<HyperlaneContractsMap<CoreFactories>> {
    const contractsMap = await super.deploy(configMap);
    this.deployedContracts = objMap(contractsMap, (chain, core) => ({
      ...core,
      ...this.deployedHooks[chain],
    }));
    return contractsMap;
  }
}
