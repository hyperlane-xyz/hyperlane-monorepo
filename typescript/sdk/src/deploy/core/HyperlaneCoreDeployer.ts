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
import { ChainNameToDomainId, DomainIdToChainName } from '../../domains';
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
    // TODO: Config is broken somehow, skipping
    // if (multisigIsm.address) return multisigIsm;
    const configChains = Object.keys(this.configMap) as Chain[];
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const remotes = this.multiProvider
      .intersect(configChains, false)
      .multiProvider.remoteChains(chain);
    await super.runIfOwner(chain, multisigIsm, async () => {
      // TODO: Remove extraneous validators
      const configEntries = await Promise.all(
        remotes.map(async (remote) => {
          const remoteDomain = ChainNameToDomainId[remote];
          const multisigIsmConfig = this.configMap[remote].multisigIsm;
          const unenrolledValidators = await Promise.all(
            multisigIsmConfig.validators.filter(
              async (validator) =>
                !(await multisigIsm.isEnrolled(remoteDomain, validator)),
            ),
          );
          const currentThreshold = await multisigIsm.threshold(remoteDomain);
          const thresholdEntry = currentThreshold.eq(
            multisigIsmConfig.threshold,
          )
            ? undefined
            : multisigIsmConfig.threshold;
          const validatorsEntry =
            unenrolledValidators.length > 0 ? unenrolledValidators : undefined;
          this.logger(remote, validatorsEntry);
          return [remoteDomain, thresholdEntry, validatorsEntry];
        }),
      );
      const validatorEntries = configEntries.filter(
        (entry): entry is [number, number, string[]] => entry[2] !== undefined,
      );
      // TODO: Why is this failing?
      const validatorDomains = validatorEntries.map(([id]) => id);
      const validatorAddresses = validatorEntries.map(
        ([, , addresses]) => addresses,
      );
      for (const entry of validatorEntries) {
        this.logger(
          `Enroll ${DomainIdToChainName[entry[0]]} validators on ${chain}: ${
            entry[2]
          }`,
        );
      }
      // TODO: This is failing
      await chainConnection.handleTx(
        multisigIsm.enrollValidators(
          validatorDomains,
          validatorAddresses,
          chainConnection.overrides,
        ),
      );

      const thresholdEntries = configEntries.filter(
        (entry): entry is [number, number, string[]] => entry[1] !== undefined,
      );
      const thresholdDomains = thresholdEntries.map(([id]) => id);
      const thresholdChains = thresholdDomains.map(
        (id) => DomainIdToChainName[id],
      );
      const thresholds = thresholdEntries.map(([, threshold]) => threshold);
      this.logger(
        `Set remote (${thresholdChains}) thresholds on ${chain}: ${thresholds}`,
      );
      await chainConnection.handleTx(
        multisigIsm.setThresholds(
          thresholdDomains,
          thresholds,
          chainConnection.overrides,
        ),
      );
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
