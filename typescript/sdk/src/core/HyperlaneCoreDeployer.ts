import debug from 'debug';

import {
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  Mailbox,
  MerkleTreeHook,
  MerkleTreeHook__factory,
  ValidatorAnnounce,
} from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { IsmConfig } from '../ism/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';

import { CoreFactories, coreFactories } from './contracts';
import { CoreConfig } from './types';

export class HyperlaneCoreDeployer extends HyperlaneDeployer<
  CoreConfig,
  CoreFactories
> {
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
    const mailbox = await this.deployContract(chain, 'mailbox', [
      domain,
      owner,
    ]);

    // deploy default ISM
    const defaultIsmAddress = await this.deployIsm(chain, ismConfig);
    await this.multiProvider.handleTx(
      domain,
      mailbox.setDefaultIsm(defaultIsmAddress),
    );

    // deploy required hook
    const merkleTreeHook = await this.deployMerkleTreeHook(
      chain,
      mailbox.address,
    );
    await this.multiProvider.handleTx(
      domain,
      mailbox.setRequiredHook(merkleTreeHook.address),
    );

    // deploy default hook
    const igpHook = await this.deployIgpHook(chain);
    await this.multiProvider.handleTx(
      domain,
      mailbox.setDefaultHook(igpHook.address),
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
    const merkleTree = await new MerkleTreeHook__factory(
      this.multiProvider.getSigner(chain),
    ).deploy(mailboxAddress);
    await this.multiProvider.handleTx(chain, merkleTree.deployTransaction);
    return merkleTree;
  }

  async deployIgpHook(chain: ChainName): Promise<InterchainGasPaymaster> {
    this.logger(`Deploying Interchain Gas Paymaster Hook to ${chain}`);
    const igp = await new InterchainGasPaymaster__factory(
      this.multiProvider.getSigner(chain),
    ).deploy();
    await this.multiProvider.handleTx(chain, igp.deployTransaction);
    return igp;
  }

  async deployContracts(
    chain: ChainName,
    config: CoreConfig,
  ): Promise<HyperlaneContracts<CoreFactories>> {
    if (config.remove) {
      // skip deploying to chains configured to be removed
      return undefined as any;
    }

    const mailbox = await this.deployMailbox(
      chain,
      config.defaultIsm,
      config.owner,
    );

    const validatorAnnounce = await this.deployValidatorAnnounce(
      chain,
      mailbox.address,
    );

    return {
      mailbox,
      validatorAnnounce,
    };
  }
}
