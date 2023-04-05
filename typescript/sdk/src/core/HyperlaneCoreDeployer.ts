import debug from 'debug';

import { Mailbox, Ownable, ValidatorAnnounce } from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts';
import { DeployOptions, HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';
import { objMap } from '../utils/objects';

import { CoreFactories, coreFactories } from './contracts';
import { CoreConfig } from './types';

export class HyperlaneCoreDeployer extends HyperlaneDeployer<
  CoreConfig,
  CoreFactories
> {
  startingBlockNumbers: ChainMap<number | undefined>;

  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<CoreConfig>,
    readonly ismFactory: HyperlaneIsmFactory,
    factoriesOverride = coreFactories,
  ) {
    super(multiProvider, configMap, factoriesOverride, {
      logger: debug('hyperlane:CoreDeployer'),
    });
    this.startingBlockNumbers = objMap(configMap, () => undefined);
  }

  async deployMailbox(
    chain: ChainName,
    defaultIsmAddress: types.Address,
    proxyAdmin: types.Address,
    deployOpts?: DeployOptions,
  ): Promise<Mailbox> {
    const domain = this.multiProvider.getDomainId(chain);
    const owner = this.configMap[chain].owner;

    const mailbox = await this.deployProxiedContract(
      chain,
      'mailbox',
      [domain],
      [owner, defaultIsmAddress],
      proxyAdmin,
      deployOpts,
    );
    return mailbox;
  }

  async deployValidatorAnnounce(
    chain: ChainName,
    mailboxAddress: string,
    deployOpts?: DeployOptions,
  ): Promise<ValidatorAnnounce> {
    const validatorAnnounce = await this.deployContract(
      chain,
      'validatorAnnounce',
      [mailboxAddress],
      deployOpts,
    );
    return validatorAnnounce;
  }

  async deployIsm(chain: ChainName): Promise<types.Address> {
    const config = this.configMap[chain].defaultIsm;
    const cachedMailbox = this.deployedContracts[chain]?.['mailbox'];
    if (cachedMailbox) {
      const module = await cachedMailbox.defaultIsm();
      const matches = await this.ismFactory.matches(chain, module, config);
      if (!matches) {
        return this.ismFactory.deploy(chain, config);
      }
      return module;
    } else {
      return this.ismFactory.deploy(chain, config);
    }
  }

  async deployContracts(
    chain: ChainName,
    config: CoreConfig,
  ): Promise<HyperlaneContracts<CoreFactories>> {
    if (config.remove) {
      // skip deploying to chains configured to be removed
      return undefined as any;
    }

    const provider = this.multiProvider.getProvider(chain);
    const startingBlockNumber = await provider.getBlockNumber();
    this.startingBlockNumbers[chain] = startingBlockNumber;

    const ism = await this.deployIsm(chain);
    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);

    const mailbox = await this.deployMailbox(chain, ism, proxyAdmin.address);
    const validatorAnnounce = await this.deployValidatorAnnounce(
      chain,
      mailbox.address,
    );
    // Ownership of the Mailbox and the interchainGasPaymaster is transferred upon initialization.
    // TODO: How to handle ownership of routingISM contract(s)?
    const ownables: Ownable[] = [multisigIsm, proxyAdmin];
    await this.transferOwnershipOfContracts(chain, config.owner, ownables);

    return {
      validatorAnnounce,
      proxyAdmin,
      mailbox,
    };
  }
}
