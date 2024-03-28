import { BytesLike, PopulatedTransaction } from 'ethers';

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
import { ChainName } from '../../types';

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
    }
    return account;
  }

  // meant for ICA governance to return the populatedTx
  async getCallRemote(
    chain: ChainName,
    destination: ChainName,
    innerCalls: CallData[],
    routerOverride?: Address,
    ismOverride?: Address,
    hookMetadata?: BytesLike,
  ): Promise<PopulatedTransaction> {
    const localRouter = this.router(this.contractsMap[chain]);
    const remoteDomain = this.multiProvider.getDomainId(destination);
    const quote = await localRouter.quoteGasPayment(remoteDomain);
    const remoteRouter = addressToBytes32(
      routerOverride ?? this.router(this.contractsMap[destination]).address,
    );
    const remoteIsm = addressToBytes32(
      ismOverride ??
        (await this.router(this.contractsMap[destination]).isms(remoteDomain)),
    );
    const icaCall: CallData = {
      to: localRouter.address,
      data: localRouter.interface.encodeFunctionData(
        'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes)',
        [
          remoteDomain,
          remoteRouter,
          remoteIsm,
          innerCalls.map((call) => ({
            to: addressToBytes32(call.to),
            value: call.value,
            data: call.data,
          })),
          hookMetadata ?? '0x',
        ],
      ),
      value: quote,
    };
    return icaCall;
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
  async callRemote(
    chain: ChainName,
    destination: ChainName,
    calls: Array<CallData>,
    routerOverride?: Address,
    ismOverride?: Address,
    hookMetadata?: string,
  ): Promise<void> {
    const localRouter = this.router(this.contractsMap[chain]);
    const remoteDomain = this.multiProvider.getDomainId(destination);
    const quote = await localRouter.quoteGasPayment(remoteDomain);
    const remoteRouter = addressToBytes32(
      routerOverride ?? this.router(this.contractsMap[destination]).address,
    );
    const remoteIsm = addressToBytes32(
      ismOverride ??
        (await this.router(this.contractsMap[destination]).isms(remoteDomain)),
    );
    await this.multiProvider.handleTx(
      chain,
      localRouter[
        'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes)'
      ](
        this.multiProvider.getDomainId(destination),
        remoteRouter,
        remoteIsm,
        calls.map((call) => ({
          to: addressToBytes32(call.to),
          value: call.value,
          data: call.data,
        })),
        hookMetadata ?? '0x',
        { value: quote },
      ),
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
