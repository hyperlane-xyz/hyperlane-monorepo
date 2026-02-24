import {
  Hex,
  concatHex,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbi,
  zeroHash,
} from 'viem';
import { z } from 'zod';

import {
  InterchainAccountRouter,
  InterchainAccountRouter__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  CallData,
  addBufferToGasLimit,
  addressToBytes32,
  arrayToObject,
  bytes32ToAddress,
  eqAddress,
  formatStandardHookMetadata,
  isZeroishAddress,
  objFilter,
  objMap,
  parseStandardHookMetadata,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { appFromAddressesMapHelper } from '../../contracts/contracts.js';
import {
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
} from '../../contracts/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import type { EvmTransactionResponseLike } from '../../providers/evmTypes.js';
import { CallData as SdkCallData } from '../../providers/transactions/types.js';
import { RouterApp } from '../../router/RouterApps.js';
import { ChainMap, ChainName } from '../../types.js';
import {
  estimateCallGas,
  estimateHandleGasForRecipient,
} from '../../utils/gas.js';

import {
  InterchainAccountFactories,
  interchainAccountFactories,
} from './contracts.js';
import { AccountConfig, GetCallRemoteSettings } from './types.js';

const IGP_DEFAULT_GAS = 50_000n;
const ICA_OVERHEAD = 50_000n;
const PER_CALL_OVERHEAD = 5_000n;
const ICA_HANDLE_GAS_FALLBACK = 200_000n;

type PopulatedTransaction = Awaited<
  ReturnType<
    ReturnType<
      typeof InterchainAccountRouter__factory.connect
    >['populateTransaction']['callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes)']
  >
>;

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
  ): Promise<Address> {
    return this.getOrDeployAccount(false, destinationChain, config);
  }

  async deployAccount(
    destinationChain: ChainName,
    config: AccountConfig,
  ): Promise<Address> {
    return this.getOrDeployAccount(true, destinationChain, config);
  }

  protected async getOrDeployAccount(
    deployIfNotExists: boolean,
    destinationChain: ChainName,
    config: AccountConfig,
  ): Promise<Address> {
    const originDomain = this.multiProvider.tryGetDomainId(config.origin);
    if (!originDomain) {
      throw new Error(
        `Origin chain (${config.origin}) metadata needed for deploying ICAs ...`,
      );
    }
    const destinationRouter = this.router(this.contractsMap[destinationChain]);
    const originRouterAddress = config.localRouter
      ? bytes32ToAddress(config.localRouter)
      : bytes32ToAddress(await destinationRouter.routers(originDomain));
    if (isZeroishAddress(originRouterAddress)) {
      throw new Error(
        `Origin router address is zero for ${config.origin} on ${destinationChain}`,
      );
    }

    const destinationIsmAddress = bytes32ToAddress(
      addressToBytes32(
        config.ismOverride ?? (await destinationRouter.isms(originDomain)),
      ),
    );
    const destinationAccount = (await destinationRouter[
      'getLocalInterchainAccount(uint32,address,address,address)'
    ](
      originDomain,
      config.owner,
      originRouterAddress,
      destinationIsmAddress,
    )) as string;

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
            gasLimit: gasWithBuffer,
            ...txOverrides,
          },
        ) as Promise<EvmTransactionResponseLike>,
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

  /**
   * Encode the ICA message body for handle() call estimation.
   * Mirrors solidity/contracts/middleware/libs/InterchainAccountMessage.sol#encode
   */
  encodeIcaMessageBody(
    owner: Hex,
    ism: Hex,
    calls: { to: Hex; value: bigint; data: Hex }[],
    salt: Hex = zeroHash,
  ): string {
    const MESSAGE_TYPE_CALLS = 0;
    const prefix = encodePacked(
      ['uint8', 'bytes32', 'bytes32', 'bytes32'],
      [MESSAGE_TYPE_CALLS, owner, ism, salt],
    );
    const suffix = encodeAbiParameters(
      [
        {
          name: 'calls',
          type: 'tuple[]',
          components: [
            { name: 'to', type: 'bytes32' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
          ],
        },
      ],
      [calls as any],
    );
    return concatHex([prefix, suffix]);
  }

  /**
   * Estimate gas for ICA handle() execution on destination chain.
   */
  async estimateIcaHandleGas({
    origin,
    destination,
    innerCalls,
    config,
  }: {
    origin: string;
    destination: string;
    innerCalls: SdkCallData[];
    config: AccountConfig;
  }): Promise<bigint> {
    const originDomain = this.multiProvider.getDomainId(origin);
    const destinationRouter = config.routerOverride
      ? InterchainAccountRouter__factory.connect(
          config.routerOverride,
          this.multiProvider.getProvider(destination),
        )
      : this.router(this.contractsMap[destination]);

    const localRouterAddress = config.localRouter
      ? bytes32ToAddress(config.localRouter)
      : this.routerAddress(origin);

    const remoteIsm = addressToBytes32(
      config.ismOverride ?? (await destinationRouter.isms(originDomain)),
    );

    const formattedCalls = innerCalls.map((call) => ({
      to: addressToBytes32(call.to) as Hex,
      value: BigInt(call.value ?? '0'),
      data: (call.data ?? '0x') as Hex,
    }));

    const messageBody = this.encodeIcaMessageBody(
      addressToBytes32(config.owner) as Hex,
      remoteIsm as Hex,
      formattedCalls,
    );

    try {
      const mailbox = await destinationRouter.mailbox();
      const gasEstimate = await estimateHandleGasForRecipient({
        recipient: destinationRouter,
        origin: originDomain,
        sender: addressToBytes32(localRouterAddress),
        body: messageBody,
        mailbox,
      });

      if (gasEstimate) {
        return addBufferToGasLimit(gasEstimate);
      }
    } catch {
      // Fall through to individual call estimation
    }

    this.logger.warn(
      { destination },
      'Failed to estimate ICA handle gas, trying individual call estimation',
    );

    try {
      const provider = this.multiProvider.getProvider(destination);
      const individualEstimates = await Promise.all(
        formattedCalls.map((call) =>
          estimateCallGas({
            provider,
            to: bytes32ToAddress(call.to),
            data: call.data,
            value: call.value,
          }),
        ),
      );
      const totalGas = individualEstimates.reduce((sum, gas) => sum + gas, 0n);
      const overhead =
        ICA_OVERHEAD + PER_CALL_OVERHEAD * BigInt(formattedCalls.length);
      return addBufferToGasLimit(totalGas + overhead);
    } catch {
      this.logger.warn(
        { destination },
        'Individual call estimation also failed, using static fallback',
      );
      return ICA_HANDLE_GAS_FALLBACK;
    }
  }

  // meant for ICA governance to return the populatedTx
  async getCallRemote({
    chain,
    destination,
    innerCalls,
    config,
    hookMetadata,
  }: GetCallRemoteSettings): Promise<PopulatedTransaction> {
    const localRouter = config.localRouter
      ? InterchainAccountRouter__factory.connect(
          config.localRouter,
          this.multiProvider.getSigner(chain),
        )
      : this.router(this.contractsMap[chain]);
    const originDomain = this.multiProvider.getDomainId(chain);
    const remoteDomain = this.multiProvider.getDomainId(destination);

    const remoteRouter = addressToBytes32(
      config.routerOverride ?? this.routerAddress(destination),
    );
    // ISMs are indexed by origin domain (where messages come FROM)
    // For legacy routers, we need to use routerOverride to get the ISM
    const destinationRouterForIsm = config.routerOverride
      ? InterchainAccountRouter__factory.connect(
          config.routerOverride,
          this.multiProvider.getProvider(destination),
        )
      : this.router(this.contractsMap[destination]);
    const remoteIsm = addressToBytes32(
      config.ismOverride ?? (await destinationRouterForIsm.isms(originDomain)),
    );

    // Handle both string and object hookMetadata formats
    const resolvedHookMetadata =
      typeof hookMetadata === 'string'
        ? hookMetadata
        : hookMetadata
          ? formatStandardHookMetadata({
              msgValue: hookMetadata.msgValue
                ? BigInt(hookMetadata.msgValue)
                : undefined,
              gasLimit: hookMetadata.gasLimit
                ? BigInt(hookMetadata.gasLimit)
                : undefined,
              refundAddress: hookMetadata.refundAddress,
            })
          : '0x';

    const gasLimitForQuote =
      typeof hookMetadata === 'object' && hookMetadata?.gasLimit
        ? BigInt(hookMetadata.gasLimit)
        : resolvedHookMetadata !== '0x'
          ? (this.extractGasLimitFromMetadata(resolvedHookMetadata) ??
            IGP_DEFAULT_GAS)
          : IGP_DEFAULT_GAS;

    const formattedCalls = innerCalls.map((call) => ({
      to: addressToBytes32(call.to) as Hex,
      value: BigInt(call.value ?? '0'),
      data: (call.data ?? '0x') as Hex,
    }));

    let quote: bigint;
    try {
      const quoteResult = (await localRouter['quoteGasPayment(uint32,uint256)'](
        remoteDomain,
        gasLimitForQuote,
      )) as bigint | number | string | { toString(): string };
      quote = BigInt(quoteResult.toString());
    } catch {
      // Legacy ICA routers have broken quoteGasPayment that doesn't use hookMetadata.
      // Query the mailbox directly to get accurate quote with our metadata.
      const mailboxAddress = await localRouter.mailbox();
      const provider = this.multiProvider.getProvider(chain);
      const mailboxAbi = parseAbi([
        'function quoteDispatch(uint32,bytes32,bytes,bytes,address) view returns (uint256)',
        'function defaultHook() view returns (address)',
      ]);
      const defaultHookCall = await provider.call({
        to: mailboxAddress,
        data: encodeFunctionData({
          abi: mailboxAbi,
          functionName: 'defaultHook',
        }),
      });
      const defaultHook = decodeFunctionResult({
        abi: mailboxAbi,
        functionName: 'defaultHook',
        data: defaultHookCall as Hex,
      });
      const messageBody = this.encodeIcaMessageBody(
        addressToBytes32(config.owner) as Hex,
        remoteIsm as Hex,
        formattedCalls,
      );
      const quoteDispatchCall = await provider.call({
        to: mailboxAddress as Hex,
        data: encodeFunctionData({
          abi: mailboxAbi,
          functionName: 'quoteDispatch',
          args: [
            remoteDomain,
            remoteRouter as Hex,
            messageBody as Hex,
            resolvedHookMetadata as Hex,
            defaultHook as Hex,
          ],
        }),
      });
      quote = decodeFunctionResult({
        abi: mailboxAbi,
        functionName: 'quoteDispatch',
        data: quoteDispatchCall as Hex,
      });
    }

    return {
      to: localRouter.address,
      data: localRouter.interface.encodeFunctionData(
        'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes)',
        [
          remoteDomain,
          remoteRouter as Hex,
          remoteIsm as Hex,
          formattedCalls,
          resolvedHookMetadata as Hex,
        ],
      ),
      value: quote,
    };
  }

  private extractGasLimitFromMetadata(metadata: string): bigint | null {
    const parsed = parseStandardHookMetadata(metadata);
    return parsed ? BigInt(parsed.gasLimit) : null;
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
  coreAddressesByChain: ChainMap<Record<string, string>>,
): Promise<InterchainAccount> {
  if (!config.localRouter) {
    throw new Error('localRouter is required for account deployment');
  }

  let remoteIcaAddresses: ChainMap<{ interchainAccountRouter: Address }>;
  const localChainAddresses = coreAddressesByChain[chain];
  // if the user specified a custom router address we need to retrieve the remote ica addresses
  // configured on the user provided router, otherwise we use the ones defined in the registry
  if (
    localChainAddresses?.interchainAccountRouter &&
    eqAddress(config.localRouter, localChainAddresses.interchainAccountRouter)
  ) {
    remoteIcaAddresses = objMap(coreAddressesByChain, (_, chainAddresses) => ({
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

        return {
          interchainAccountRouter: bytes32ToAddress(routerAddress),
        };
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
  coreAddressesByChain: ChainMap<Record<string, string>>,
): Promise<Address> {
  const interchainAccountApp: InterchainAccount =
    await buildInterchainAccountApp(
      multiProvider,
      chain,
      config,
      coreAddressesByChain,
    );
  return interchainAccountApp.deployAccount(chain, config);
}

export function encodeIcaCalls(calls: CallData[], salt: string) {
  return concatHex([
    salt as Hex,
    encodeAbiParameters(
      [
        {
          name: 'calls',
          type: 'tuple[]',
          components: [
            { name: 'to', type: 'bytes32' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
          ],
        },
      ],
      [
        calls.map((c) => ({
          to: addressToBytes32(c.to) as Hex,
          value: c.value ?? 0n,
          data: c.data as Hex,
        })),
      ],
    ),
  ]);
}

// Convenience function to transform value strings to bigint
export type RawCallData = {
  to: string;
  value?: string | number;
  data: string;
};

export function normalizeCalls(calls: RawCallData[]): CallData[] {
  return calls.map((call) => ({
    to: addressToBytes32(call.to),
    value: BigInt(call.value || 0),
    data: call.data,
  }));
}

export function commitmentFromIcaCalls(
  calls: CallData[],
  salt: string,
): string {
  return keccak256(encodeIcaCalls(calls, salt));
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
