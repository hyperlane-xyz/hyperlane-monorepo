/* 
const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);
const mailbox = await this.deployMailbox(chain, config, proxyAdmin.address);
const validatorAnnounce
*/

/* import { Mailbox, ValidatorAnnounce } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';


import { HyperlaneContracts } from '../contracts/types'; */
// import { HyperlaneHookDeployer } from '../hook/HyperlaneHookDeployer';
// import { HookConfig } from '../hook/types';

/* import {
  HyperlaneIsmFactory,
  moduleMatchesConfig,
} from '../ism/HyperlaneIsmFactory';
 */
// import { IsmConfig } from '../ism/types';
import { chainMetadata } from '../consts/chainMetadata';
import { ChainMetadata } from '../metadata/chainMetadataTypes';
// import { CoreAddresses, CoreFactories, coreFactories } from './contracts';
import { ChainMap, ChainName } from '../types';

import { HyperlaneProxyFactoryDeployer } from './HyperlaneProxyFactoryDeployer';
import { getMultiProvider } from './utils';

export async function executeDeploy() {
  // init var
  let key: string;
  key = '0x61c382e3d00e76b315fa610b6f34c6744c217f899457070825bcde0dbf53037a';

  // Config
  const customChains: ChainMap<ChainMetadata> = chainMetadata;
  // let signer = keyToSigner(key);

  const multiProvider = getMultiProvider(customChains);
  const chains: ChainName[] = ['zksyncera'];

  // 1. Deploy ISM factories to all deployable chains that don't have them.
  const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
  const ismFactoryConfig = chains.reduce((chainMap, curr) => {
    chainMap[curr] = {};
    return chainMap;
  }, {} as ChainMap<{}>);
  const ismFactoryContracts = await ismFactoryDeployer.deploy(ismFactoryConfig);
}

/* export class HyperlaneCoreDeployer {
  

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

    let defaultIsm = await mailbox.defaultIsm();
    const matches = await moduleMatchesConfig(
      chain,
      defaultIsm,
      config.defaultIsm,
      this.multiProvider,
      this.ismFactory.getContracts(chain),
    );
    if (!matches) {
      this.logger('Deploying default ISM');
      defaultIsm = await this.deployIsm(
        chain,
        config.defaultIsm,
        mailbox.address,
      );
    }
    this.cachedAddresses[chain].interchainSecurityModule = defaultIsm;

    const hookAddresses = { mailbox: mailbox.address, proxyAdmin };

    this.logger('Deploying default hook');
    const defaultHook = await this.deployHook(
      chain,
      config.defaultHook,
      hookAddresses,
    );

    this.logger('Deploying required hook');
    const requiredHook = await this.deployHook(
      chain,
      config.requiredHook,
      hookAddresses,
    );

    // configure mailbox
    try {
      this.logger('Initializing mailbox');
      await this.multiProvider.handleTx(
        chain,
        mailbox.initialize(
          config.owner,
          defaultIsm,
          defaultHook,
          requiredHook,
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
        !e.error?.reason?.includes('already initialized')
      ) {
        throw e;
      }

      this.logger('Mailbox already initialized');

      await this.configureHook(
        chain,
        mailbox,
        defaultHook,
        (_mailbox) => _mailbox.defaultHook(),
        (_mailbox, _hook) => _mailbox.populateTransaction.setDefaultHook(_hook),
      );

      await this.configureHook(
        chain,
        mailbox,
        requiredHook,
        (_mailbox) => _mailbox.requiredHook(),
        (_mailbox, _hook) =>
          _mailbox.populateTransaction.setRequiredHook(_hook),
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
  ): Promise<Address> {
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
    return hooks[config.type].address;
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
 */
