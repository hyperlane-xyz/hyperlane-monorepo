import debug from 'debug';

import {
  Mailbox,
  MerkleTreeHook,
  MerkleTreeHook__factory,
  ValidatorAnnounce,
} from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HyperlaneIgpDeployer } from '../gas/HyperlaneIgpDeployer';
import { IgpFactories } from '../gas/contracts';
import { OverheadIgpConfig } from '../gas/types';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { HyperlaneIsmFactoryDeployer } from '../ism/HyperlaneIsmFactoryDeployer';
import { IsmConfig } from '../ism/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { CoreFactories, coreFactories } from './contracts';
import { CoreConfig } from './types';

export class HyperlaneCoreDeployer extends HyperlaneDeployer<
  CoreConfig,
  CoreFactories
> {
  ismFactoryDeployer: HyperlaneIsmFactoryDeployer;
  igpDeployer: HyperlaneIgpDeployer;

  constructor(
    multiProvider: MultiProvider,
    public ismFactory?: HyperlaneIsmFactory,
    factories = coreFactories,
  ) {
    super(multiProvider, factories, {
      logger: debug('hyperlane:CoreDeployer'),
      chainTimeoutMs: 1000 * 60 * 10, // 10 minutes
    });
    this.ismFactoryDeployer = new HyperlaneIsmFactoryDeployer(multiProvider);
    this.igpDeployer = new HyperlaneIgpDeployer(multiProvider);
  }

  async deployMailbox(
    chain: ChainName,
    ismConfig: IsmConfig,
    proxyAdmin: types.Address,
    defaultHook: types.Address,
    owner: types.Address,
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

    // deploy mailbox
    const domain = this.multiProvider.getDomainId(chain);
    const mailbox = await this.deployProxiedContract(
      chain,
      'mailbox',
      proxyAdmin,
      [domain],
    );

    // deploy default ISM
    const defaultIsm = await this.deployIsm(chain, ismConfig);

    // deploy required hook
    const merkleTreeHook = await this.deployMerkleTreeHook(
      chain,
      mailbox.address,
    );

    // configure mailbox
    await this.multiProvider.handleTx(
      chain,
      mailbox.initialize(
        owner,
        defaultIsm,
        defaultHook,
        merkleTreeHook.address,
      ),
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
    if (!this.ismFactory) {
      const contracts = await this.ismFactoryDeployer.deploy([chain]);
      this.ismFactory = new HyperlaneIsmFactory(contracts, this.multiProvider);
    }

    this.logger(`Deploying new ISM to ${chain}`);
    const ism = await this.ismFactory.deploy(chain, config);
    return ism.address;
  }

  async deployMerkleTreeHook(
    chain: ChainName,
    mailboxAddress: string,
  ): Promise<MerkleTreeHook> {
    this.logger(`Deploying Merkle Tree Hook to ${chain}`);
    const merkleTreeFactory = new MerkleTreeHook__factory();
    return this.multiProvider.handleDeploy(chain, merkleTreeFactory, [
      mailboxAddress,
    ]);
  }

  async deployIgpContracts(
    chain: ChainName,
    config: OverheadIgpConfig,
  ): Promise<HyperlaneContracts<IgpFactories>> {
    this.logger(`Deploying Interchain Gas Paymaster to ${chain}`);
    return this.igpDeployer.deployContracts(chain, config);
  }

  async deployContracts(
    chain: ChainName,
    config: CoreConfig,
  ): Promise<HyperlaneContracts<CoreFactories>> {
    if (config.remove) {
      // skip deploying to chains configured to be removed
      return undefined as any;
    }

    const igpContracts = await this.deployIgpContracts(chain, config);

    const timelockController = igpContracts.timelockController;
    const proxyAdmin = igpContracts.proxyAdmin;
    const defaultHook = igpContracts.defaultIsmInterchainGasPaymaster.address;

    const mailbox = await this.deployMailbox(
      chain,
      config.defaultIsm,
      proxyAdmin.address,
      defaultHook,
      config.owner,
    );

    const validatorAnnounce = await this.deployValidatorAnnounce(
      chain,
      mailbox.address,
    );

    return {
      mailbox,
      proxyAdmin,
      timelockController,
      validatorAnnounce,
    };
  }

  igpContracts(): ChainMap<HyperlaneContracts<IgpFactories>> {
    return this.igpDeployer.deployedContracts;
  }
}
