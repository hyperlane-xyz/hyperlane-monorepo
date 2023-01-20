import debug from 'debug';
import { ethers } from 'ethers';

import {
  InterchainGasPaymaster,
  Mailbox,
  MultisigIsm,
  OverheadIgp,
  Ownable,
  Ownable__factory,
  ProxyAdmin,
  ValidatorAnnounce,
} from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../../consts/chainMetadata';
import multisigIsmVerifyCosts from '../../consts/multisigIsmVerifyCosts.json';
import { CoreContracts, coreFactories } from '../../core/contracts';
import { ChainNameToDomainId } from '../../domains';
import { MultiProvider } from '../../providers/MultiProvider';
import { ProxiedContract, TransparentProxyAddresses } from '../../proxy';
import { ChainMap, ChainName } from '../../types';
import { objMap } from '../../utils/objects';
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
  gasOverhead: ChainMap<Chain, OverheadIgp.DomainConfigStruct>;

  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, CoreConfig>,
    factoriesOverride = coreFactories,
  ) {
    super(multiProvider, configMap, factoriesOverride, {
      logger: debug('hyperlane:CoreDeployer'),
    });
    this.gasOverhead = objMap(configMap, (chain, config) => {
      const { validators, threshold } = config.multisigIsm;
      const verifyCost =
        // @ts-ignore
        multisigIsmVerifyCosts[`${validators.length}`][`${threshold}`];
      if (!verifyCost)
        throw new Error(
          `Unknown verification cost for ${threshold} of ${validators.length}`,
        );
      return {
        domain: ChainNameToDomainId[chain],
        gasOverhead: verifyCost,
      };
    });
    this.startingBlockNumbers = objMap(configMap, () => undefined);
  }

  async deployInterchainGasPaymaster<LocalChain extends Chain>(
    chain: LocalChain,
    proxyAdmin: ProxyAdmin,
    deployOpts?: DeployOptions,
  ): Promise<
    ProxiedContract<InterchainGasPaymaster, TransparentProxyAddresses>
  > {
    const interchainGasPaymaster = await this.deployProxiedContract(
      chain,
      'interchainGasPaymaster',
      [],
      proxyAdmin,
      [],
      deployOpts,
    );
    return interchainGasPaymaster;
  }

  async deployDefaultIsmInterchainGasPaymaster<LocalChain extends Chain>(
    chain: LocalChain,
    interchainGasPaymasterAddress: types.Address,
    deployOpts?: DeployOptions,
  ): Promise<OverheadIgp> {
    const owner = this.configMap[chain].owner;
    const initCalldata = Ownable__factory.createInterface().encodeFunctionData(
      'transferOwnership',
      [owner],
    );
    const defaultIsmInterchainGasPaymaster = await this.deployContract(
      chain,
      'defaultIsmInterchainGasPaymaster',
      [interchainGasPaymasterAddress],
      {
        ...deployOpts,
        initCalldata,
      },
    );

    const configChains = Object.keys(this.configMap) as Chain[];
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const remotes = this.multiProvider
      .intersect(configChains, false)
      .multiProvider.remoteChains(chain);

    const configs = remotes.map((remote) => this.gasOverhead[remote]);
    await chainConnection.handleTx(
      defaultIsmInterchainGasPaymaster.setDestinationGasOverheads(configs),
    );

    return defaultIsmInterchainGasPaymaster;
  }

  async deployMailbox<LocalChain extends Chain>(
    chain: LocalChain,
    defaultIsmAddress: types.Address,
    proxyAdmin: ProxyAdmin,
    deployOpts?: DeployOptions,
  ): Promise<ProxiedContract<Mailbox, TransparentProxyAddresses>> {
    const domain = chainMetadata[chain].id;
    const owner = this.configMap[chain].owner;

    const mailbox = await this.deployProxiedContract(
      chain,
      'mailbox',
      [domain],
      proxyAdmin,
      [owner, defaultIsmAddress],
      deployOpts,
    );
    return mailbox;
  }

  async deployValidatorAnnounce<LocalChain extends Chain>(
    chain: LocalChain,
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
      const remoteDomains = remotes.map((chain) => ChainNameToDomainId[chain]);
      const actualValidators = await Promise.all(
        remoteDomains.map((id) => multisigIsm.validators(id)),
      );
      const expectedValidators = remotes.map(
        (chain) => this.configMap[chain].multisigIsm.validators,
      );
      const validatorsToEnroll = expectedValidators.map((validators, i) =>
        validators.filter(
          (validator) =>
            !actualValidators[i].includes(ethers.utils.getAddress(validator)),
        ),
      );
      const chainsToEnrollValidators = remotes.filter(
        (_, i) => validatorsToEnroll[i].length > 0,
      );

      if (chainsToEnrollValidators.length > 0) {
        this.logger(
          `Enroll ${chainsToEnrollValidators} validators on ${chain}`,
        );
        await chainConnection.handleTx(
          multisigIsm.enrollValidators(
            chainsToEnrollValidators.map((c) => ChainNameToDomainId[c]),
            validatorsToEnroll.filter((validators) => validators.length > 0),
            chainConnection.overrides,
          ),
        );
      }

      const actualThresholds = await Promise.all(
        remoteDomains.map((id) => multisigIsm.threshold(id)),
      );
      const expectedThresholds = remotes.map(
        (chain) => this.configMap[chain].multisigIsm.threshold,
      );
      const chainsToSetThreshold = remotes.filter(
        (_, i) => actualThresholds[i] !== expectedThresholds[i],
      );
      if (chainsToSetThreshold.length > 0) {
        this.logger(
          `Set remote (${chainsToSetThreshold}) thresholds on ${chain}`,
        );
        await chainConnection.handleTx(
          multisigIsm.setThresholds(
            chainsToSetThreshold.map((c) => ChainNameToDomainId[c]),
            chainsToSetThreshold.map(
              (c) => this.configMap[c].multisigIsm.threshold,
            ),
            chainConnection.overrides,
          ),
        );
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
    const defaultIsmInterchainGasPaymaster =
      await this.deployDefaultIsmInterchainGasPaymaster(
        chain,
        interchainGasPaymaster.address,
      );
    const mailbox = await this.deployMailbox(
      chain,
      multisigIsm.address,
      proxyAdmin,
    );
    const validatorAnnounce = await this.deployValidatorAnnounce(
      chain,
      mailbox.address,
    );
    // Ownership of the Mailbox, the interchainGasPaymaster, and defaultIsmInterchainGasPaymaster
    // is transferred upon initialization.
    const ownables: Ownable[] = [multisigIsm, proxyAdmin];
    await this.transferOwnershipOfContracts(chain, ownables);

    return {
      validatorAnnounce,
      proxyAdmin,
      mailbox,
      interchainGasPaymaster,
      defaultIsmInterchainGasPaymaster,
      multisigIsm,
    };
  }

  async transferOwnershipOfContracts(
    chain: Chain,
    ownables: Ownable[],
  ): Promise<ethers.ContractReceipt[]> {
    const owner = this.configMap[chain].owner;
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const receipts = await Promise.all(
      ownables.map(async (ownable) => {
        const currentOwner = await ownable.owner();
        if (currentOwner.toLowerCase() !== owner.toLowerCase()) {
          return chainConnection.handleTx(
            ownable.transferOwnership(owner, chainConnection.overrides),
          );
        }
        return undefined;
      }),
    );
    return receipts.filter((x) => x !== undefined) as ethers.ContractReceipt[];
  }
}
