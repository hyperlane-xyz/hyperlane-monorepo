import debug from 'debug';

import { Mailbox, ValidatorAnnounce } from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneContracts, filterOwnableContracts } from '../contracts';
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
    this.logger('Mailbox address: ', mailbox.address, 'on chain: ', chain);
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

    // const ism = await this.deployIsm(chain, config.defaultIsm);
    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);

    // default ISM
    const prodISM =
      chain === 'test1'
        ? '0xec48E52D960E54a179f70907bF28b105813877ee'
        : '0xAab1D11E2063Bae5EB01fa946cA8d2FDe3db05D5';

    const mailbox = await this.deployMailbox(
      chain,
      prodISM,
      proxyAdmin.address,
      config.owner,
    );
    const validatorAnnounce = await this.deployValidatorAnnounce(
      chain,
      mailbox.address,
    );

    const contracts = {
      validatorAnnounce,
      proxyAdmin,
      mailbox,
    };
    // Transfer ownership of all ownable contracts
    const ownables = await filterOwnableContracts(contracts);
    await this.transferOwnershipOfContracts(chain, config.owner, ownables);
    return contracts;
  }
}
