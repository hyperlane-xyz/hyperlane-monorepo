import { BigNumber, PopulatedTransaction, utils } from 'ethers';

import { InterchainAccountRouter } from '@hyperlane-xyz/core';
import {
  Address,
  CallData,
  addBufferToGasLimit,
  addressToBytes32,
  bytes32ToAddress,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { appFromAddressesMapHelper } from '../../contracts/contracts.js';
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
import { AccountConfig, GetCallRemoteSettings } from './types.js';

export class InterchainAccount extends RouterApp<InterchainAccountFactories> {
  knownAccounts: Record<Address, AccountConfig | undefined>;

  constructor(
    contractsMap: HyperlaneContractsMap<InterchainAccountFactories>,
    multiProvider: MultiProvider,
  ) {
    super(contractsMap, multiProvider);
    this.knownAccounts = {};
  }

  override async remoteChains(chainName: string): Promise<ChainName[]> {
    return Object.keys(this.contractsMap).filter(
      (chain) => chain !== chainName,
    );
  }

  router(
    contracts: HyperlaneContracts<InterchainAccountFactories>,
  ): InterchainAccountRouter {
    return contracts.interchainAccountRouter;
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

  async getAccount(
    destinationChain: ChainName,
    config: AccountConfig,
    routerOverride?: Address,
    ismOverride?: Address,
  ): Promise<Address> {
    return this.getOrDeployAccount(
      false,
      destinationChain,
      config,
      routerOverride,
      ismOverride,
    );
  }

  async deployAccount(
    destinationChain: ChainName,
    config: AccountConfig,
    routerOverride?: Address,
    ismOverride?: Address,
  ): Promise<Address> {
    return this.getOrDeployAccount(
      true,
      destinationChain,
      config,
      routerOverride,
      ismOverride,
    );
  }

  protected async getOrDeployAccount(
    deployIfNotExists: boolean,
    destinationChain: ChainName,
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
    const destinationRouter = this.router(this.contractsMap[destinationChain]);
    const originRouterAddress =
      routerOverride ??
      bytes32ToAddress(await destinationRouter.routers(originDomain));
    if (isZeroishAddress(originRouterAddress)) {
      throw new Error(
        `Origin router address is zero for ${config.origin} on ${destinationChain}`,
      );
    }

    const destinationIsmAddress =
      ismOverride ??
      bytes32ToAddress(await destinationRouter.isms(originDomain));
    const destinationAccount = await destinationRouter[
      'getLocalInterchainAccount(uint32,address,address,address)'
    ](originDomain, config.owner, originRouterAddress, destinationIsmAddress);

    // If not deploying anything, return the account address.
    if (!deployIfNotExists) {
      return destinationAccount;
    }

    // If the account does not exist, deploy it.
    if (
      (await this.multiProvider
        .getProvider(destinationChain)
        .getCode(destinationAccount)) === '0x'
    ) {
      const txOverrides =
        this.multiProvider.getTransactionOverrides(destinationChain);

      // Estimate gas for deployment
      const gasEstimate = await destinationRouter.estimateGas[
        'getDeployedInterchainAccount(uint32,address,address,address)'
      ](originDomain, config.owner, originRouterAddress, destinationIsmAddress);

      // Add buffer to gas estimate
      const gasWithBuffer = addBufferToGasLimit(gasEstimate);

      // Execute deployment with buffered gas estimate
      await this.multiProvider.handleTx(
        destinationChain,
        destinationRouter[
          'getDeployedInterchainAccount(uint32,address,address,address)'
        ](
          originDomain,
          config.owner,
          originRouterAddress,
          destinationIsmAddress,
          {
            ...txOverrides,
            gasLimit: gasWithBuffer,
          },
        ),
      );
      this.logger.debug(`Interchain account deployed at ${destinationAccount}`);
    } else {
      this.logger.debug(
        `Interchain account recovered at ${destinationAccount}`,
      );
    }

    this.knownAccounts[destinationAccount] = config;

    return destinationAccount;
  }

  // meant for ICA governance to return the populatedTx
  async getCallRemote({
    chain,
    destination,
    innerCalls,
    config,
    hookMetadata,
  }: GetCallRemoteSettings): Promise<PopulatedTransaction> {
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

  // general helper for different overloaded callRemote functions
  // can override the gasLimit by StandardHookMetadata.overrideGasLimit for optional hookMetadata here
  async callRemote({
    chain,
    destination,
    innerCalls,
    config,
    hookMetadata,
  }: GetCallRemoteSettings): Promise<void> {
    await this.multiProvider.sendTransaction(
      chain,
      this.getCallRemote({
        chain,
        destination,
        innerCalls,
        config,
        hookMetadata,
      }),
    );
  }
}

export function buildInterchainAccountApp(
  multiProvider: MultiProvider,
  chain: ChainName,
  config: AccountConfig,
): InterchainAccount {
  if (!config.localRouter) {
    throw new Error('localRouter is required for account deployment');
  }
  const addressesMap: HyperlaneAddressesMap<any> = {
    [chain]: { interchainAccountRouter: config.localRouter },
  };
  return InterchainAccount.fromAddressesMap(addressesMap, multiProvider);
}

export async function deployInterchainAccount(
  multiProvider: MultiProvider,
  chain: ChainName,
  config: AccountConfig,
): Promise<Address> {
  const interchainAccountApp: InterchainAccount = buildInterchainAccountApp(
    multiProvider,
    chain,
    config,
  );
  return interchainAccountApp.deployAccount(chain, config);
}

export function encodeIcaCalls(calls: CallData[], salt: string) {
  return utils.defaultAbiCoder.encode(
    ['bytes32', 'tuple(bytes32 to,uint256 value,bytes data)[]'],
    [
      salt,
      calls.map((c) => ({
        to: addressToBytes32(c.to),
        value: c.value || 0,
        data: c.data,
      })),
    ],
  );
}

// Convenience function to transform value strings to bignumber
type UnstructuredCallData = {
  to: string;
  value?: string | number;
  data: string;
};
export function normalizeCalls(calls: UnstructuredCallData[]): CallData[] {
  return calls.map((call) => ({
    to: addressToBytes32(call.to),
    value: BigNumber.from(call.value || 0),
    data: call.data,
  }));
}

export function commitmentFromIcaCalls(
  calls: CallData[],
  salt: string,
): string {
  return utils.keccak256(encodeIcaCalls(calls, salt));
}

export function shareCallsWithPrivateRelayer(
  calls: CallData[],
  salt: string,
  relayers: string[],
  commitmentMessageId: string,
  serverUrl: string,
): Promise<Response> {
  return fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commitmentMessageId,
      calls,
      relayers,
      salt,
    }),
  });
}
