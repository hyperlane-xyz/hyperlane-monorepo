import { BigNumber, PopulatedTransaction, utils } from 'ethers';
import { z } from 'zod';

import {
  InterchainAccountRouter,
  InterchainAccountRouter__factory,
} from '@hyperlane-xyz/core';
import { IRegistry } from '@hyperlane-xyz/registry';
import {
  Address,
  CallData,
  addBufferToGasLimit,
  addressToBytes32,
  arrayToObject,
  bytes32ToAddress,
  eqAddress,
  isZeroishAddress,
  objFilter,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { appFromAddressesMapHelper } from '../../contracts/contracts.js';
import {
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
} from '../../contracts/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { RouterApp } from '../../router/RouterApps.js';
import { ChainMap, ChainName } from '../../types.js';

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

export async function buildInterchainAccountApp(
  multiProvider: MultiProvider,
  chain: ChainName,
  config: AccountConfig,
  registry: Readonly<IRegistry>,
): Promise<InterchainAccount> {
  if (!config.localRouter) {
    throw new Error('localRouter is required for account deployment');
  }

  let remoteIcaAddresses: ChainMap<{ interchainAccountRouter: Address }>;
  const localChainAddresses = await registry.getChainAddresses(chain);
  // if the user specified a custom router address we need to retrieve the remote ica addresses
  // configured on the user provided router, otherwise we use the ones defined in the registry
  if (
    localChainAddresses?.interchainAccountRouter &&
    eqAddress(config.localRouter, localChainAddresses.interchainAccountRouter)
  ) {
    const addressByChain = await registry.getAddresses();

    remoteIcaAddresses = objMap(addressByChain, (_, chainAddresses) => ({
      interchainAccountRouter: chainAddresses.interchainAccountRouter,
    }));
  } else {
    const currentIca = InterchainAccountRouter__factory.connect(
      config.localRouter,
      multiProvider.getSigner(chain),
    );

    const knownDomains = await currentIca.domains();
    remoteIcaAddresses = await promiseObjAll(
      objMap(arrayToObject(knownDomains.map(String)), async (domainId) => {
        const routerAddress = await currentIca.routers(domainId);

        return { interchainAccountRouter: bytes32ToAddress(routerAddress) };
      }),
    );
  }

  // remove the undefined or 0 addresses values
  remoteIcaAddresses = objFilter(
    remoteIcaAddresses,
    (
      _chainId,
      chainAddresses,
    ): chainAddresses is { interchainAccountRouter: Address } =>
      !!chainAddresses.interchainAccountRouter &&
      !isZeroishAddress(chainAddresses.interchainAccountRouter),
  );

  const addressesMap: HyperlaneAddressesMap<any> = {
    [chain]: {
      interchainAccountRouter: config.localRouter,
    },
    ...remoteIcaAddresses,
  };
  return InterchainAccount.fromAddressesMap(addressesMap, multiProvider);
}

export async function deployInterchainAccount(
  multiProvider: MultiProvider,
  chain: ChainName,
  config: AccountConfig,
  registry: IRegistry,
): Promise<Address> {
  const interchainAccountApp: InterchainAccount =
    await buildInterchainAccountApp(multiProvider, chain, config, registry);
  return interchainAccountApp.deployAccount(chain, config);
}

export function encodeIcaCalls(calls: CallData[], salt: string) {
  return (
    salt +
    utils.defaultAbiCoder
      .encode(
        ['tuple(bytes32 to,uint256 value,bytes data)[]'],
        [
          calls.map((c) => ({
            to: addressToBytes32(c.to),
            value: c.value || 0,
            data: c.data,
          })),
        ],
      )
      .slice(2)
  );
}

// Convenience function to transform value strings to bignumber
export type RawCallData = {
  to: string;
  value?: string | number;
  data: string;
};

export function normalizeCalls(calls: RawCallData[]): CallData[] {
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

export const PostCallsSchema = z.object({
  calls: z
    .array(
      z.object({
        to: z.string(),
        data: z.string(),
        value: z.string().optional(),
      }),
    )
    .min(1),
  relayers: z.array(z.string()),
  salt: z.string(),
  commitmentDispatchTx: z.string(),
  originDomain: z.number(),
});

export type PostCallsType = z.infer<typeof PostCallsSchema>;

export async function shareCallsWithPrivateRelayer(
  serverUrl: string,
  payload: PostCallsType,
): Promise<Response> {
  const resp = await fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    // Read body
    const body = await resp.text();
    throw new Error(
      `Failed to share calls with relayer: ${resp.status} ${body}`,
    );
  }

  return resp;
}
