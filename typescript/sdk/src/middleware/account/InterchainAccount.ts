import { BigNumber, BytesLike, PopulatedTransaction } from 'ethers';

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
} from '../../consts/environments/index.js';
import {
  appFromAddressesMapHelper,
  filterChainMapToProtocol,
} from '../../contracts/contracts.js';
import {
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
} from '../../contracts/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { RouterApp } from '../../router/RouterApps.js';
import { ChainName } from '../../types.js';

import {
  InterchainAccountFactories,
  interchainAccountFactories,
} from './contracts.js';
import { AccountConfig } from './types.js';

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

  async deployAccount(
    chain: ChainName,
    config: AccountConfig,
    routerOverride?: Address,
    ismOverride?: Address,
  ): Promise<Address> {
    const originDomain = this.multiProvider.tryGetDomainId(config.origin);
    if (!originDomain) {
      throw new Error(
        `Origin chain (${config.origin}) metadata needed for deploying ICAs ...`,
      );
    }
    const localRouter = this.router(this.contractsMap[chain]);
    const routerAddress =
      routerOverride ??
      bytes32ToAddress(await localRouter.routers(originDomain));
    const ismAddress =
      ismOverride ?? bytes32ToAddress(await localRouter.isms(originDomain));
    const account = await localRouter[
      'getLocalInterchainAccount(uint32,address,address,address)'
    ](originDomain, config.owner, routerAddress, ismAddress);
    if (
      (await this.multiProvider.getProvider(chain).getCode(account)) === '0x'
    ) {
      await this.multiProvider.handleTx(
        chain,
        localRouter[
          'getDeployedInterchainAccount(uint32,address,address,address)'
        ](originDomain, config.owner, routerAddress, ismAddress),
      );
      this.logger.debug(`Interchain account deployed at ${account}`);
    } else {
      this.logger.debug(`Interchain account recovered at ${account}`);
    }
    return account;
  }

  // meant for ICA governance to return the populatedTx
  async getCallRemote(
    chain: ChainName,
    destination: ChainName,
    innerCalls: CallData[],
    config: AccountConfig,
    hookMetadata?: BytesLike,
  ): Promise<PopulatedTransaction> {
    const localRouter = this.router(this.contractsMap[chain]);
    const remoteDomain = this.multiProvider.getDomainId(destination);
    const quote = await localRouter['quoteGasPayment(uint32)'](remoteDomain);
    const remoteRouter = addressToBytes32(
      config.routerOverride ?? this.routerAddress(destination),
    );
    const remoteIsm = addressToBytes32(
      config.ismOverride ??
        (await this.router(this.contractsMap[destination]).isms(remoteDomain)),
    );
    const callEncoded = await localRouter.populateTransaction[
      'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes)'
    ](
      remoteDomain,
      remoteRouter,
      remoteIsm,
      innerCalls.map((call) => ({
        to: addressToBytes32(call.to),
        value: call.value ?? BigNumber.from('0'),
        data: call.data,
      })),
      hookMetadata ?? '0x',
      { value: quote },
    );
    return callEncoded;
  }

  async getAccountConfig(
    chain: ChainName,
    account: Address,
  ): Promise<AccountConfig> {
    const accountOwner = await this.router(
      this.contractsMap[chain],
    ).accountOwners(account);
    const originChain = this.multiProvider.getChainName(accountOwner.origin);
    return {
      origin: originChain,
      owner: accountOwner.owner,
      localRouter: this.router(this.contractsMap[chain]).address,
    };
  }

  // general helper for different overloaded callRemote functions
  // can override the gasLimit by StandardHookMetadata.overrideGasLimit for optional hookMetadata here
  async callRemote(
    chain: ChainName,
    destination: ChainName,
    calls: Array<CallData>,
    config: AccountConfig,
    hookMetadata?: string,
  ): Promise<void> {
    await this.multiProvider.sendTransaction(
      chain,
      this.getCallRemote(chain, destination, calls, config, hookMetadata),
    );
  }
}

export async function deployInterchainAccount(
  multiProvider: MultiProvider,
  chain: ChainName,
  config: AccountConfig,
): Promise<Address> {
  if (!config.localRouter) {
    throw new Error('localRouter is required for account deployment');
  }
  const addressesMap: HyperlaneAddressesMap<any> = {
    [chain]: { interchainAccountRouter: config.localRouter },
  };
  const router = InterchainAccount.fromAddressesMap(
    addressesMap,
    multiProvider,
  );
  return router.deployAccount(chain, config);
}
