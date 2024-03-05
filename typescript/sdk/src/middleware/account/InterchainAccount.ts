import { InterchainAccountRouter } from '@hyperlane-xyz/core';
import {
  Address,
  CallData,
  ProtocolType,
  addressToBytes32,
  bytes32ToAddress,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../../consts/environments';
import {
  appFromAddressesMapHelper,
  filterChainMapToProtocol,
} from '../../contracts/contracts';
import {
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
} from '../../contracts/types';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterApp } from '../../router/RouterApps';
import { ChainMap, ChainName } from '../../types';

import {
  InterchainAccountFactories,
  interchainAccountFactories,
} from './contracts';
import { AccountConfig } from './types';

export class InterchainAccount extends RouterApp<InterchainAccountFactories> {
  constructor(
    contractsMap: HyperlaneContractsMap<InterchainAccountFactories>,
    multiProvider: MultiProvider,
  ) {
    super(contractsMap, multiProvider);
  }

  router(
    contracts: HyperlaneContracts<InterchainAccountFactories>,
  ): InterchainAccountRouter {
    return contracts.interchainAccountRouter;
  }

  static fromEnvironment<Env extends HyperlaneEnvironment>(
    env: Env,
    multiProvider: MultiProvider,
  ): InterchainAccount {
    const envAddresses = hyperlaneEnvironments[env];
    if (!envAddresses) {
      throw new Error(`No addresses found for ${env}`);
    }
    // Filter out non-EVM chains, as interchain accounts are EVM only at the moment.
    const ethAddresses = filterChainMapToProtocol(
      envAddresses,
      ProtocolType.Ethereum,
      multiProvider,
    );
    return InterchainAccount.fromAddressesMap(ethAddresses, multiProvider);
  }

  static fromAddressesMap(
    addressesMap: HyperlaneAddressesMap<any>,
    multiProvider: MultiProvider,
  ): InterchainAccount {
    const helper = appFromAddressesMapHelper(
      addressesMap,
      interchainAccountFactories,
      multiProvider,
    );
    return new InterchainAccount(helper.contractsMap, helper.multiProvider);
  }

  async deployAccounts(
    config: ChainMap<AccountConfig>,
  ): Promise<ChainMap<Address>> {
    const accounts: ChainMap<Address> = {};
    for (const chain of Object.keys(config)) {
      accounts[chain] = await this.deployAccount(chain, config[chain]);
    }
    return accounts;
  }

  async deployAccount(
    chain: ChainName,
    config: AccountConfig,
  ): Promise<Address> {
    const originDomain = this.multiProvider.getDomainId(config.origin);
    const localRouter = this.router(this.contractsMap[chain]);
    await this.multiProvider.handleTx(
      chain,
      localRouter[
        'getDeployedInterchainAccount(uint32,address,address,address)'
      ](
        originDomain,
        config.owner,
        bytes32ToAddress(await localRouter.routers(originDomain)),
        bytes32ToAddress(await localRouter.isms(originDomain)),
      ),
    );
    const account = await localRouter[
      'getLocalInterchainAccount(uint32,address,address,address)'
    ](
      originDomain,
      config.owner,
      bytes32ToAddress(await localRouter.routers(originDomain)),
      bytes32ToAddress(await localRouter.isms(originDomain)),
    );
    return account;
  }

  async callRemote(
    chain: ChainName,
    destination: ChainName,
    calls: Array<CallData>,
    routerOverride?: Address,
    ismOverride?: Address,
    hookMetadata?: string,
  ): Promise<void> {
    const callsWithValue = calls.map((call) => ({
      to: addressToBytes32(call.to),
      data: call.data,
      value: 0,
    }));
    if (routerOverride && ismOverride && hookMetadata) {
      await this.multiProvider.handleTx(
        destination,
        this.router(this.contractsMap[chain]).callRemoteWithOverrides(
          this.multiProvider.getDomainId(destination),
          addressToBytes32(routerOverride),
          addressToBytes32(ismOverride),
          callsWithValue,
          hookMetadata,
        ),
      );
    } else if (hookMetadata) {
      await this.multiProvider.handleTx(
        destination,
        this.router(this.contractsMap[chain])[
          'callRemote(uint32,(bytes32,uint256,bytes)[],bytes)'
        ](
          this.multiProvider.getDomainId(destination),
          callsWithValue,
          hookMetadata,
        ),
      );
    } else {
      await this.multiProvider.handleTx(
        destination,
        this.router(this.contractsMap[chain])[
          'callRemote(uint32,(bytes32,uint256,bytes)[])'
        ](this.multiProvider.getDomainId(destination), callsWithValue),
      );
    }
  }
}
