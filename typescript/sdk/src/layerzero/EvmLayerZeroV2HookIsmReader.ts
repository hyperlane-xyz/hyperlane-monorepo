import {
  LayerZeroV2CallbackHookIsm__factory,
  LayerZeroV2CcipReadHookIsm__factory,
} from '@hyperlane-xyz/core';
import { Address, bytes32ToAddress } from '@hyperlane-xyz/utils';
import { Contract } from 'ethers';

import { OnchainHookType } from '../hook/types.js';
import { ModuleType } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

import {
  DerivedLayerZeroV2HookIsmConfig,
  LayerZeroV2RemoteRouterConfig,
  LayerZeroV2Variant,
} from './types.js';

const ENDPOINT_READ_ABI = [
  'function getSendLibrary(address,uint32) view returns (address)',
  'function getReceiveLibrary(address,uint32) view returns (address,bool)',
  'function receiveLibraryTimeout(address,uint32) view returns (address,uint256)',
  'function delegates(address) view returns (address)',
  'function getConfig(address,address,uint32,uint32) view returns (bytes)',
];
const LAYER_ZERO_V2_SEND_CONFIG_TYPES = [1, 2] as const;
const LAYER_ZERO_V2_RECEIVE_CONFIG_TYPES = [2] as const;

export class EvmLayerZeroV2HookIsmReader {
  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
  ) {}

  async deriveVariant(address: Address): Promise<LayerZeroV2Variant> {
    const router = LayerZeroV2CcipReadHookIsm__factory.connect(
      address,
      this.multiProvider.getProvider(this.chain),
    );
    const moduleType = await router.moduleType();
    if (moduleType === ModuleType.NULL) return LayerZeroV2Variant.Callback;
    if (moduleType === ModuleType.CCIP_READ) return LayerZeroV2Variant.CcipRead;
    throw new Error(
      `${address} on ${this.chain} reports module type ${moduleType}, not LayerZero`,
    );
  }

  async deriveLayerZeroConfig(
    address: Address,
    knownVariant?: LayerZeroV2Variant,
  ): Promise<DerivedLayerZeroV2HookIsmConfig> {
    const provider = this.multiProvider.getProvider(this.chain);
    const marker = LayerZeroV2CallbackHookIsm__factory.connect(
      address,
      provider,
    );
    if ((await marker.hookType()) !== OnchainHookType.LAYER_ZERO) {
      throw new Error(
        `${address} on ${this.chain} is not a supported LayerZero V2 hook/ISM`,
      );
    }
    const variant = knownVariant ?? (await this.deriveVariant(address));
    const router = LayerZeroV2CcipReadHookIsm__factory.connect(
      address,
      provider,
    );
    const [mailbox, endpointAddress, layerZeroDomainId, owner, domains] =
      await Promise.all([
        router.mailbox(),
        router.endpoint(),
        router.localEid(),
        router.owner(),
        router.domains(),
      ]);
    const endpoint = new Contract(endpointAddress, ENDPOINT_READ_ABI, provider);
    const delegate = await endpoint.delegates(address);
    if (delegate !== '0x0000000000000000000000000000000000000000') {
      throw new Error(
        `LayerZero hook/ISM ${address} on ${this.chain} has unexpected Endpoint delegate ${delegate}`,
      );
    }

    const entries = await Promise.all(
      domains.map(async (domainValue) => {
        const domain = Number(domainValue);
        const remoteEid = Number(await router.remoteConfigs(domain));
        const [routerAddress, sendLibrary, receive, timeout] =
          await Promise.all([
            router.routers(domain),
            endpoint.getSendLibrary(address, remoteEid),
            endpoint.getReceiveLibrary(address, remoteEid),
            endpoint.receiveLibraryTimeout(address, remoteEid),
          ]);
        const [sendConfig, receiveConfig] = await Promise.all([
          this.deriveLibraryConfig(
            endpoint,
            address,
            sendLibrary,
            remoteEid,
            LAYER_ZERO_V2_SEND_CONFIG_TYPES,
          ),
          this.deriveLibraryConfig(
            endpoint,
            address,
            receive[0],
            remoteEid,
            LAYER_ZERO_V2_RECEIVE_CONFIG_TYPES,
          ),
        ]);
        const chainName =
          this.multiProvider.tryGetChainName(domain) ?? domain.toString();
        const remote: LayerZeroV2RemoteRouterConfig = {
          router: bytes32ToAddress(routerAddress),
          layerZeroDomainId: remoteEid,
          sendLibrary,
          receiveLibrary: receive[0],
          receiveLibraryGracePeriod: 0,
          sendConfig,
          receiveConfig,
          ...(timeout[0] !== '0x0000000000000000000000000000000000000000'
            ? {
                receiveLibraryTimeout: {
                  library: timeout[0],
                  expiry: Number(timeout[1]),
                },
              }
            : {}),
          ...(variant === LayerZeroV2Variant.Callback
            ? {
                callbackGasLimit: (
                  await LayerZeroV2CallbackHookIsm__factory.connect(
                    address,
                    provider,
                  ).callbackGasLimits(domain)
                ).toBigInt(),
              }
            : {}),
        };
        return [chainName, remote] as const;
      }),
    );

    return {
      address,
      type: variant,
      owner,
      mailbox,
      endpoint: endpointAddress,
      layerZeroDomainId: Number(layerZeroDomainId),
      ...(variant === LayerZeroV2Variant.CcipRead
        ? { urls: await router.urls() }
        : {}),
      remoteRouters: Object.fromEntries(entries),
    };
  }

  private async deriveLibraryConfig(
    endpoint: Contract,
    oapp: Address,
    library: Address,
    eid: number,
    configTypes: readonly (1 | 2)[],
  ): Promise<Array<{ configType: 1 | 2; config: string }>> {
    const entries = await Promise.all(
      configTypes.map(async (configType) => {
        const config: string = await endpoint.getConfig(
          oapp,
          library,
          eid,
          configType,
        );
        return config === '0x' ? undefined : { configType, config };
      }),
    );
    return entries.filter(
      (entry): entry is { configType: 1 | 2; config: string } => !!entry,
    );
  }
}
