import debug from 'debug';
import { ethers } from 'ethers';

import {
  InterchainGasPaymaster,
  Mailbox,
  MultisigIsm,
  Ownable,
  ProxyAdmin,
} from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../../consts/chainMetadata';
import { HyperlaneCore } from '../../core/HyperlaneCore';
import { CoreContracts, coreFactories } from '../../core/contracts';
import { ChainNameToDomainId } from '../../domains';
import { ChainConnection } from '../../providers/ChainConnection';
import { MultiProvider } from '../../providers/MultiProvider';
import { ProxiedContract, TransparentProxyAddresses } from '../../proxy';
import { ChainMap, ChainName } from '../../types';
import { objMap, promiseObjAll } from '../../utils/objects';
import { DeployOptions, HyperlaneDeployer } from '../HyperlaneDeployer';

import { CoreConfig } from './types';

export class HyperlaneCoreDeployer<
  Chain extends ChainName,
> extends HyperlaneDeployer<
  Chain,
  CoreConfig,
  CoreContracts,
  typeof coreFactories
> {
  startingBlockNumbers: ChainMap<Chain, number | undefined>;

  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, CoreConfig>,
    factoriesOverride = coreFactories,
  ) {
    super(multiProvider, configMap, factoriesOverride, {
      logger: debug('hyperlane:CoreDeployer'),
    });
    this.startingBlockNumbers = objMap(configMap, () => undefined);
  }

  deployInterchainGasPaymaster<LocalChain extends Chain>(
    chain: LocalChain,
    proxyAdmin: ProxyAdmin,
    deployOpts?: DeployOptions,
  ): Promise<
    ProxiedContract<InterchainGasPaymaster, TransparentProxyAddresses>
  > {
    return this.deployProxiedContract(
      chain,
      'interchainGasPaymaster',
      [],
      proxyAdmin,
      [],
      deployOpts,
    );
  }

  async deployMailbox<LocalChain extends Chain>(
    chain: LocalChain,
    defaultIsmAddress: types.Address,
    proxyAdmin: ProxyAdmin,
    deployOpts?: DeployOptions,
  ): Promise<ProxiedContract<Mailbox, TransparentProxyAddresses>> {
    const domain = chainMetadata[chain].id;

    const mailbox = await this.deployProxiedContract(
      chain,
      'mailbox',
      [domain],
      proxyAdmin,
      [defaultIsmAddress],
      deployOpts,
    );
    return mailbox;
  }

  async deployMultisigIsm<LocalChain extends Chain>(
    chain: LocalChain,
  ): Promise<MultisigIsm> {
    const multisigIsm = await this.deployContract(chain, 'multisigIsm', []);
    const configChains = Object.keys(this.configMap) as Chain[];
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const remotes = this.multiProvider
      .intersect(configChains, false)
      .multiProvider.remoteChains(chain);
    await super.runIfOwner(chain, multisigIsm, async () => {
      // TODO: Remove extraneous validators
      for (const remote of remotes) {
        const multisigIsmConfig = this.configMap[remote].multisigIsm;
        const domain = ChainNameToDomainId[remote];
        await Promise.all(
          multisigIsmConfig.validators.map(async (validator) => {
            const isValidator = await multisigIsm.isEnrolled(domain, validator);
            if (!isValidator) {
              this.logger(
                `Enrolling ${validator} as ${remote} validator on ${chain}`,
              );
              await chainConnection.handleTx(
                multisigIsm.enrollValidator(
                  domain,
                  validator,
                  chainConnection.overrides,
                ),
              );
            }
          }),
        );
        const threshold = await multisigIsm.threshold(domain);
        if (!threshold.eq(multisigIsmConfig.threshold)) {
          this.logger(
            `Setting ${remote} threshold to ${multisigIsmConfig.threshold} on ${chain}`,
          );
          await chainConnection.handleTx(
            multisigIsm.setThreshold(
              domain,
              multisigIsmConfig.threshold,
              chainConnection.overrides,
            ),
          );
        }
      }
    });

    return multisigIsm;
  }

  async deployContracts<LocalChain extends Chain>(
    chain: LocalChain,
    config: CoreConfig,
  ): Promise<CoreContracts> {
    if (config.remove) {
      // skip deploying to chains configured to be removed
      return undefined as any;
    }

    const dc = this.multiProvider.getChainConnection(chain);
    const provider = dc.provider!;
    const startingBlockNumber = await provider.getBlockNumber();
    this.startingBlockNumbers[chain] = startingBlockNumber;
    const multisigIsm = await this.deployMultisigIsm(chain);

    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);
    const interchainGasPaymaster = await this.deployInterchainGasPaymaster(
      chain,
      proxyAdmin,
    );
    const mailbox = await this.deployMailbox(
      chain,
      multisigIsm.address,
      proxyAdmin,
    );

    return {
      proxyAdmin,
      interchainGasPaymaster,
      mailbox,
      multisigIsm,
    };
  }

  static async transferOwnership<CoreChains extends ChainName>(
    core: HyperlaneCore<CoreChains>,
    owners: ChainMap<CoreChains, types.Address>,
    multiProvider: MultiProvider<CoreChains>,
  ): Promise<ChainMap<CoreChains, ethers.ContractReceipt[]>> {
    return promiseObjAll(
      objMap(core.contractsMap, async (chain, coreContracts) =>
        HyperlaneCoreDeployer.transferOwnershipOfChain(
          coreContracts,
          owners[chain],
          multiProvider.getChainConnection(chain),
        ),
      ),
    );
  }

  static async transferOwnershipOfChain(
    coreContracts: CoreContracts,
    owner: types.Address,
    chainConnection: ChainConnection,
  ): Promise<ethers.ContractReceipt[]> {
    const ownables: Ownable[] = [
      coreContracts.mailbox.contract,
      coreContracts.multisigIsm,
      coreContracts.proxyAdmin,
    ];
    return Promise.all(
      ownables.map((ownable) =>
        chainConnection.handleTx(
          ownable.transferOwnership(owner, chainConnection.overrides),
        ),
      ),
    );
  }
}
