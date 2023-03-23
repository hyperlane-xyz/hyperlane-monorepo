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
  GasOracleContracts,
  HyperlaneCoreDeployer,
  MultiProvider,
  ProxiedContract,
  TransparentProxyAddresses,
  chainMetadata,
  objMap,
} from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { DeployEnvironment, RustConfig } from '../config';
import {
  ConnectionType,
  RustChainSetupBase,
  RustConnection,
} from '../config/agent';
import { deployEnvToSdkEnv } from '../config/environment';
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
    gasOracleContracts: GasOracleContracts,
  ): Promise<
    ProxiedContract<InterchainGasPaymaster, TransparentProxyAddresses>
  > {
    const deployOpts = {
      create2Salt: ethers.utils.solidityKeccak256(
        ['string', 'string', 'uint8'],
        [this.environment, 'interchainGasPaymaster', 6],
      ),
    };
    return super.deployInterchainGasPaymaster(
      chain,
      proxyAdmin,
      gasOracleContracts,
      deployOpts,
    );
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
      chains: {},
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

      const chainConfig: RustChainSetupBase = {
        name: chain,
        domain: metadata.chainId,
        addresses: {
          mailbox: contracts.mailbox.contract.address,
          interchainGasPaymaster: contracts.interchainGasPaymaster.address,
          validatorAnnounce: contracts.validatorAnnounce.address,
        },
        protocol: 'ethereum',
        finalityBlocks: metadata.blocks!.reorgPeriod!,
        connection: {
          // not a valid connection but we want to fill in the HTTP type for
          // them as a default and leave out the URL
          type: ConnectionType.Http,
          url: undefined,
        } as any as RustConnection,
      };

      const startingBlockNumber = this.startingBlockNumbers[chain];
      if (startingBlockNumber) {
        chainConfig.index = { from: startingBlockNumber };
      }

      rustConfig.chains[chain] = chainConfig;
    });
    writeJSON(
      directory,
      `${deployEnvToSdkEnv[this.environment]}_config.json`,
      rustConfig,
    );
  }
}
