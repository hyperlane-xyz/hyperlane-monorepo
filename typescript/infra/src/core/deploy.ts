import { ethers } from 'ethers';

import {
  InterchainGasPaymaster,
  Mailbox,
  OverheadIgp,
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

export class HyperlaneCoreInfraDeployer extends HyperlaneCoreDeployer {
  environment: DeployEnvironment;

  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<CoreConfig>,
    environment: DeployEnvironment,
  ) {
    super(multiProvider, configMap);
    this.environment = environment;
  }

  async deployInterchainGasPaymaster(
    chain: ChainName,
    proxyAdmin: ProxyAdmin,
  ): Promise<
    ProxiedContract<InterchainGasPaymaster, TransparentProxyAddresses>
  > {
    const deployOpts = {
      create2Salt: ethers.utils.solidityKeccak256(
        ['string', 'string', 'uint8'],
        [this.environment, 'interchainGasPaymaster', 6],
      ),
    };
    return super.deployInterchainGasPaymaster(chain, proxyAdmin, deployOpts);
  }

  async deployDefaultIsmInterchainGasPaymaster(
    chain: ChainName,
    interchainGasPaymasterAddress: types.Address,
  ): Promise<OverheadIgp> {
    const deployOpts = {
      create2Salt: ethers.utils.solidityKeccak256(
        ['string', 'string', 'uint8'],
        [this.environment, 'defaultIsmInterchainGasPaymaster', 4],
      ),
    };
    return super.deployDefaultIsmInterchainGasPaymaster(
      chain,
      interchainGasPaymasterAddress,
      deployOpts,
    );
  }

  async deployMailbox(
    chain: ChainName,
    defaultIsmAddress: types.Address,
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
      proxyAdmin,
      deployOpts,
    );
  }

  async deployValidatorAnnounce(
    chain: ChainName,
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
    const rustConfig: RustConfig = {
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
        domain: metadata.chainId.toString(),
        addresses: {
          mailbox: contracts.mailbox.contract.address,
          interchainGasPaymaster: contracts.interchainGasPaymaster.address,
          validatorAnnounce: contracts.validatorAnnounce.address,
        },
        signer: null,
        protocol: 'ethereum',
        finalityBlocks: metadata.blocks!.reorgPeriod!.toString(),
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
