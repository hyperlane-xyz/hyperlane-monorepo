import { BigNumber } from 'ethers';

import { InterchainAccountRouter } from '@hyperlane-xyz/core';
import {
  Address,
  AddressBytes32,
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
  ): Promise<Address> {
    const originDomain = this.multiProvider.tryGetDomainId(config.origin);
    if (!originDomain) {
      throw new Error(
        `Origin chain (${config.origin}) metadata needed for deploying ICAs ...`,
      );
    }
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
    if (
      (await this.multiProvider.getProvider(chain).getCode(account)) === '0x'
    ) {
      throw new Error('Interchain account deployment failed');
    }
    return account;
  }

  // meant for ICA governance to return the populatedTx
  async getCallRemote(
    chain: ChainName,
    destination: ChainName,
    innerCalls: CallData[],
  ): Promise<CallData> {
    const localRouter = this.router(this.contractsMap[chain]);
    const quote = await localRouter.quoteGasPayment(
      this.multiProvider.getDomainId(destination),
    );
    const icaCall: CallData = {
      to: localRouter.address,
      data: localRouter.interface.encodeFunctionData(
        'callRemote(uint32,(bytes32,uint256,bytes)[])',
        [
          this.multiProvider.getDomainId(destination),
          innerCalls.map((call) => ({
            to: addressToBytes32(call.to),
            value: call.value,
            data: call.data,
          })),
        ],
      ),
      value: quote,
    };
    return icaCall;
  }

  async getAccountOwner(
    chain: ChainName,
    account: Address,
  ): Promise<[number, AddressBytes32]> {
    return this.router(this.contractsMap[chain]).accountOwners(account);
  }

  // general helper for different overloaded callRemote functions
  async callRemote(
    chain: ChainName,
    destination: ChainName,
    calls: Array<CallData>,
    value: BigNumber,
    routerOverride?: Address,
    ismOverride?: Address,
    hookMetadata?: string,
  ): Promise<void> {
    const callsFormatted = calls.map((call) => ({
      to: addressToBytes32(call.to), // ICA Router contract expects bytes32
      data: call.data,
      value: call.value,
    }));
    if (routerOverride && ismOverride && hookMetadata) {
      await this.multiProvider.handleTx(
        chain,
        this.router(this.contractsMap[chain])[
          'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes)'
        ](
          this.multiProvider.getDomainId(destination),
          addressToBytes32(routerOverride),
          addressToBytes32(ismOverride),
          callsFormatted,
          hookMetadata,
          { value },
        ),
      );
    } else if (routerOverride && ismOverride) {
      await this.multiProvider.handleTx(
        chain,
        this.router(this.contractsMap[chain])[
          'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[])'
        ](
          this.multiProvider.getDomainId(destination),
          addressToBytes32(routerOverride),
          addressToBytes32(ismOverride),
          callsFormatted,
          { value },
        ),
      );
    } else if (hookMetadata) {
      await this.multiProvider.handleTx(
        destination,
        this.router(this.contractsMap[chain])[
          'callRemote(uint32,(bytes32,uint256,bytes)[],bytes)'
        ](
          this.multiProvider.getDomainId(destination),
          callsFormatted,
          hookMetadata,
          { value },
        ),
      );
    } else {
      await this.multiProvider.handleTx(
        chain,
        this.router(this.contractsMap[chain])[
          'callRemote(uint32,(bytes32,uint256,bytes)[])'
        ](this.multiProvider.getDomainId(destination), callsFormatted, {
          value,
        }),
      );
    }
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
