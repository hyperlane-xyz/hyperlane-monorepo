import {
  LayerZeroV2CallbackHookIsm__factory,
  LayerZeroV2CcipReadHookIsm__factory,
} from '@hyperlane-xyz/core';
import { Address, bytes32ToAddress } from '@hyperlane-xyz/utils';
import { BigNumberish, Contract } from 'ethers';

import { OnchainHookType } from '../hook/types.js';
import { ModuleType } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

import {
  DerivedLayerZeroV2HookIsmConfig,
  LayerZeroV2RemoteRouterConfig,
  LayerZeroV2Variant,
} from './types.js';
import {
  decodeLayerZeroV2AppExecutorConfig,
  decodeLayerZeroV2AppUlnConfig,
  decodeLayerZeroV2EffectiveExecutorConfig,
  decodeLayerZeroV2EffectiveUlnConfig,
  LayerZeroV2ConfigType,
} from './configCodec.js';

const ENDPOINT_READ_ABI = [
  'function getSendLibrary(address,uint32) view returns (address)',
  'function getReceiveLibrary(address,uint32) view returns (address,bool)',
  'function receiveLibraryTimeout(address,uint32) view returns (address,uint256)',
  'function delegates(address) view returns (address)',
  'function getConfig(address,address,uint32,uint32) view returns (bytes)',
];
const MESSAGE_LIBRARY_READ_ABI = [
  'function executorConfigs(address,uint32) view returns (uint32 maxMessageSize,address executor)',
  'function getAppUlnConfig(address,uint32) view returns (tuple(uint64 confirmations,uint8 requiredDVNCount,uint8 optionalDVNCount,uint8 optionalDVNThreshold,address[] requiredDVNs,address[] optionalDVNs))',
];

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
        const configs = await this.deriveLibraryConfigs(
          endpoint,
          address,
          sendLibrary,
          receive[0],
          remoteEid,
        );
        const chainName =
          this.multiProvider.tryGetChainName(domain) ?? domain.toString();
        const remote: LayerZeroV2RemoteRouterConfig = {
          router: bytes32ToAddress(routerAddress),
          layerZeroDomainId: remoteEid,
          sendLibrary,
          receiveLibrary: receive[0],
          receiveLibraryGracePeriod: 0,
          ...configs,
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

  private async deriveLibraryConfigs(
    endpoint: Contract,
    oapp: Address,
    sendLibraryAddress: Address,
    receiveLibraryAddress: Address,
    eid: number,
  ): Promise<
    Pick<
      LayerZeroV2RemoteRouterConfig,
      | 'sendConfig'
      | 'receiveConfig'
      | 'effectiveSendConfig'
      | 'effectiveReceiveConfig'
    >
  > {
    const provider = this.multiProvider.getProvider(this.chain);
    const sendLibrary = new Contract(
      sendLibraryAddress,
      MESSAGE_LIBRARY_READ_ABI,
      provider,
    );
    const receiveLibrary = new Contract(
      receiveLibraryAddress,
      MESSAGE_LIBRARY_READ_ABI,
      provider,
    );
    const [
      appExecutor,
      appSendUln,
      appReceiveUln,
      effectiveExecutor,
      effectiveSendUln,
      effectiveReceiveUln,
    ] = await Promise.all([
      sendLibrary.executorConfigs(oapp, eid),
      sendLibrary.getAppUlnConfig(oapp, eid),
      receiveLibrary.getAppUlnConfig(oapp, eid),
      endpoint.getConfig(
        oapp,
        sendLibraryAddress,
        eid,
        LayerZeroV2ConfigType.Executor,
      ),
      endpoint.getConfig(
        oapp,
        sendLibraryAddress,
        eid,
        LayerZeroV2ConfigType.Uln,
      ),
      endpoint.getConfig(
        oapp,
        receiveLibraryAddress,
        eid,
        LayerZeroV2ConfigType.Uln,
      ),
    ]);
    const appUlnConfig = (config: {
      confirmations: BigNumberish;
      requiredDVNCount: number;
      optionalDVNCount: number;
      optionalDVNThreshold: number;
      requiredDVNs: Address[];
      optionalDVNs: Address[];
    }) =>
      decodeLayerZeroV2AppUlnConfig(
        config.confirmations,
        config.requiredDVNCount,
        config.optionalDVNCount,
        config.optionalDVNThreshold,
        config.requiredDVNs,
        config.optionalDVNs,
      );
    return {
      sendConfig: {
        executor: decodeLayerZeroV2AppExecutorConfig(
          Number(appExecutor.maxMessageSize),
          appExecutor.executor,
        ),
        uln: appUlnConfig(appSendUln),
      },
      receiveConfig: { uln: appUlnConfig(appReceiveUln) },
      effectiveSendConfig: {
        executor: decodeLayerZeroV2EffectiveExecutorConfig(effectiveExecutor),
        uln: decodeLayerZeroV2EffectiveUlnConfig(effectiveSendUln),
      },
      effectiveReceiveConfig: {
        uln: decodeLayerZeroV2EffectiveUlnConfig(effectiveReceiveUln),
      },
    };
  }
}
