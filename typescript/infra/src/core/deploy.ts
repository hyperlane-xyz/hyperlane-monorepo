import { ethers } from 'ethers';

import {
  InterchainGasPaymaster,
  Mailbox,
  ProxyAdmin,
  ValidatorAnnounce,
} from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  CoreConfig,
  HyperlaneCoreDeployer,
  MultiProvider,
  ProxiedContract,
  TransparentProxyAddresses,
  chainMetadata,
  objMap,
} from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { DeployEnvironment, RustChainSetup, RustConfig } from '../config';
import { ConnectionType } from '../config/agent';
import { writeJSON } from '../utils/utils';

export class HyperlaneCoreInfraDeployer<
  Chain extends ChainName,
> extends HyperlaneCoreDeployer<Chain> {
  environment: DeployEnvironment;

  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, CoreConfig>,
    environment: DeployEnvironment,
  ) {
    super(multiProvider, configMap);
    this.environment = environment;
  }

  async deployInterchainGasPaymaster<LocalChain extends Chain>(
    chain: LocalChain,
    deployerOwnedProxyAdmin: ProxyAdmin,
    proxyAdmin: ProxyAdmin,
  ): Promise<
    ProxiedContract<InterchainGasPaymaster, TransparentProxyAddresses>
  > {
    const deployOpts = {
      create2Salt: ethers.utils.solidityKeccak256(
        ['string', 'string', 'uint8'],
        [this.environment, 'interchainGasPaymaster', 5],
      ),
    };
    return super.deployInterchainGasPaymaster(
      chain,
      deployerOwnedProxyAdmin,
      proxyAdmin,
      deployOpts,
    );
  }

  async deployDefaultIsmInterchainGasPaymaster<LocalChain extends Chain>(
    chain: LocalChain,
    interchainGasPaymasterAddress: types.Address,
  ): Promise<OverheadIgp> {
    const deployOpts = {
      create2Salt: ethers.utils.solidityKeccak256(
        ['string', 'string', 'uint8'],
        [this.environment, 'defaultIsmInterchainGasPaymaster', 3],
      ),
    };
    return super.deployDefaultIsmInterchainGasPaymaster(
      chain,
      interchainGasPaymasterAddress,
      deployOpts,
    );
  }

  async deployMailbox<LocalChain extends Chain>(
    chain: LocalChain,
    defaultIsmAddress: types.Address,
    deployerOwnedProxyAdmin: ProxyAdmin,
    proxyAdmin: ProxyAdmin,
  ): Promise<ProxiedContract<Mailbox, TransparentProxyAddresses>> {
    const deployOpts = {
      create2Salt: ethers.utils.solidityKeccak256(
        ['string', 'string', 'uint8'],
        [this.environment, 'mailbox', 1],
      ),
    };
    return super.deployMailbox(
      chain,
      defaultIsmAddress,
      deployerOwnedProxyAdmin,
      proxyAdmin,
      deployOpts,
    );
  }

  async deployValidatorAnnounce<LocalChain extends Chain>(
    chain: LocalChain,
    mailboxAddress: types.Address,
  ): Promise<ValidatorAnnounce> {
    const deployOpts = {
      create2Salt: ethers.utils.solidityKeccak256(
        ['string', 'string', 'uint8'],
        [this.environment, 'validatorAnnounce', 1],
      ),
    };
    return super.deployValidatorAnnounce(chain, mailboxAddress, deployOpts);
  }

  writeRustConfigs(directory: string) {
    const rustConfig: RustConfig<Chain> = {
      environment: this.environment,
      chains: {},
      db: 'db_path',
      tracing: {
        level: 'debug',
        fmt: 'json',
      },
    };
    objMap(this.configMap, (chain) => {
      const contracts = this.deployedContracts[chain];
      const metadata = chainMetadata[chain];
      // Don't write config for undeployed chains
      if (
        contracts == undefined ||
        contracts.mailbox == undefined ||
        contracts.interchainGasPaymaster == undefined ||
        contracts.validatorAnnounce == undefined
      ) {
        return;
      }

      const chainConfig: RustChainSetup = {
        name: chain,
        domain: metadata.id.toString(),
        addresses: {
          mailbox: contracts.mailbox.contract.address,
          interchainGasPaymaster: contracts.interchainGasPaymaster.address,
          validatorAnnounce: contracts.validatorAnnounce.address,
        },
        signer: null,
        protocol: 'ethereum',
        finalityBlocks: metadata.blocks.reorgPeriod.toString(),
        connection: {
          type: ConnectionType.Http,
          url: '',
        },
      };

      const startingBlockNumber = this.startingBlockNumbers[chain];

      if (startingBlockNumber) {
        chainConfig.index = { from: startingBlockNumber.toString() };
      }
      rustConfig.chains[chain] = chainConfig;
    });
    writeJSON(directory, `${this.environment}_config.json`, rustConfig);
  }
}
