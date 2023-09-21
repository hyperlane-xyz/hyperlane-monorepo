import debug from 'debug';
import { ethers } from 'ethers';

import {
  Mailbox,
  MerkleTreeHook,
  MerkleTreeHook__factory,
  TestInterchainGasPaymaster__factory,
  TimelockController,
  TimelockController__factory,
  ValidatorAnnounce,
} from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
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

  constructor(
    multiProvider: MultiProvider,
    readonly ismFactory: HyperlaneIsmFactory,
  ) {
    super(multiProvider, coreFactories, {
      logger: debug('hyperlane:CoreDeployer'),
      chainTimeoutMs: 1000 * 60 * 10, // 10 minutes
    });
  }

  async deployMailbox(
    chain: ChainName,
    ismConfig: IsmConfig,
    proxyAdmin: types.Address,
    _defaultHook: types.Address,
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

    console.log(
      'Deploying merkle tree hook as both the required and the default hook',
    );

    // configure mailbox
    await this.multiProvider.handleTx(
      chain,
      mailbox.initialize(
        owner,
        defaultIsm,
        merkleTreeHook.address,
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

    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);

    // TODO: deploy using default hook config
    const igp = await this.multiProvider.handleDeploy(
      chain,
      new TestInterchainGasPaymaster__factory(),
      [],
    );

    const mailbox = await this.deployMailbox(
      chain,
      config.defaultIsm,
      proxyAdmin.address,
      igp.address,
      config.owner,
    );

    const validatorAnnounce = await this.deployValidatorAnnounce(
      chain,
      mailbox.address,
    );

    let timelockController: TimelockController;
    if (config.upgrade) {
      timelockController = await this.deployTimelock(
        chain,
        config.upgrade.timelock,
      );
      await this.transferOwnershipOfContracts(
        chain,
        timelockController.address,
        { proxyAdmin },
      );
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

    // hack for including the IGP address in the agent config
    const interchainGasPaymaster = TestInterchainGasPaymaster__factory.connect(
      await mailbox.defaultHook(),
      this.multiProvider.getProvider(chain),
    );

    return {
      // @ts-ignore
      interchainGasPaymaster,
      mailbox,
      proxyAdmin,
      timelockController,
      validatorAnnounce,
    };
  }
}
