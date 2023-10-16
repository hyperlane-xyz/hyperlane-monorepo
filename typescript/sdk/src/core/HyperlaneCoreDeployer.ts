import debug from 'debug';

import { Mailbox, ValidatorAnnounce } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HyperlaneHookDeployer } from '../hook/HyperlaneHookDeployer';
import { HookConfig } from '../hook/types';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { IsmConfig } from '../ism/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { CoreAddresses, CoreFactories, coreFactories } from './contracts';
import { CoreConfig } from './types';

export class HyperlaneCoreDeployer extends HyperlaneDeployer<
  CoreConfig,
  CoreFactories
> {
  startingBlockNumbers: ChainMap<number | undefined> = {};
  hookDeployer: HyperlaneHookDeployer;

  constructor(
    multiProvider: MultiProvider,
    readonly ismFactory: HyperlaneIsmFactory,
  ) {
    super(multiProvider, coreFactories, {
      logger: debug('hyperlane:CoreDeployer'),
      chainTimeoutMs: 1000 * 60 * 10, // 10 minutes
    });
    this.hookDeployer = new HyperlaneHookDeployer(
      multiProvider,
      {},
      ismFactory,
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

    const defaultIsm = await this.deployIsm(chain, config.defaultIsm);

    const hookAddresses = { mailbox: mailbox.address, proxyAdmin };
    const defaultHook = await this.deployHook(
      chain,
      config.defaultHook,
      hookAddresses,
    );
    const requiredHook = await this.deployHook(
      chain,
      config.requiredHook,
      hookAddresses,
    );

    // configure mailbox
    try {
      await this.multiProvider.handleTx(
        chain,
        mailbox.initialize(config.owner, defaultIsm, defaultHook, requiredHook),
      );
    } catch (e: any) {
      if (!e.message.includes('already initialized')) {
        throw e;
      } else {
        this.logger('Mailbox already initialized');
      }
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
  ): Promise<Address> {
    const hooks = await this.hookDeployer.deployContracts(
      chain,
      config,
      coreAddresses,
    );
    this.addDeployedContracts(chain, hooks);
    return hooks[config.type].address;
  }

  async deployIsm(chain: ChainName, config: IsmConfig): Promise<Address> {
    const ism = await this.ismFactory.deploy(chain, config);
    this.addDeployedContracts(chain, this.ismFactory.deployedIsms[chain]);
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

    const mailbox = await this.deployMailbox(chain, config, proxyAdmin.address);

    // TODO: remove once agents fetch deployedBlock from mailbox
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
}
