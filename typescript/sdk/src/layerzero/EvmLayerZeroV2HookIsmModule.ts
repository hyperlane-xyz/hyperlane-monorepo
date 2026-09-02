import {
  LayerZeroV2CallbackHookIsm__factory,
  LayerZeroV2CcipReadHookIsm__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  addressToBytes32,
  assert,
  eqAddress,
  deepEquals,
} from '@hyperlane-xyz/utils';
import { Contract, constants, utils } from 'ethers';

import { transferOwnershipTransactions } from '../contracts/contracts.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainMap, ChainName } from '../types.js';

import { EvmLayerZeroV2HookIsmReader } from './EvmLayerZeroV2HookIsmReader.js';
import {
  DerivedLayerZeroV2HookIsmConfig,
  LayerZeroV2HookIsmConfig,
  LayerZeroV2HookIsmSchema,
  LayerZeroV2MeshConfig,
  LayerZeroV2Variant,
  findAsymmetricLayerZeroV2Routes,
  LayerZeroV2RemoteRouterConfig,
} from './types.js';

const ENDPOINT_ABI = [
  'function eid() view returns (uint32)',
  'function nativeToken() view returns (address)',
  'function delegates(address) view returns (address)',
  'function getConfig(address,address,uint32,uint32) view returns (bytes)',
];
const CCIP_READ_IFACE = new utils.Interface(['function setUrls(string[])']);

type LayerZeroV2ConfigParam = {
  eid: number;
  configType: 1 | 2;
  config: string;
};

type LayerZeroV2ConfigUpdate = {
  domain: number;
  router: string;
  receiveLibraryTimeout: string;
  receiveLibraryTimeoutExpiry: number;
  sendConfig: LayerZeroV2ConfigParam[];
  receiveConfig: LayerZeroV2ConfigParam[];
};

function remoteEnrollment(
  domain: number,
  remote: LayerZeroV2RemoteRouterConfig,
) {
  return {
    domain,
    router: addressToBytes32(remote.router),
    eid: remote.layerZeroDomainId,
    sendLibrary: remote.sendLibrary,
    receiveLibrary: remote.receiveLibrary,
    receiveLibraryGracePeriod: remote.receiveLibraryGracePeriod,
    receiveLibraryTimeout:
      remote.receiveLibraryTimeout?.library ?? constants.AddressZero,
    receiveLibraryTimeoutExpiry: remote.receiveLibraryTimeout?.expiry ?? 0,
    sendConfig: remote.sendConfig.map((param) => ({
      eid: remote.layerZeroDomainId,
      configType: param.configType,
      config: param.config,
    })),
    receiveConfig: remote.receiveConfig.map((param) => ({
      eid: remote.layerZeroDomainId,
      configType: param.configType,
      config: param.config,
    })),
  };
}

export interface LayerZeroV2MeshReconciliation {
  addresses: ChainMap<Address>;
  transactions: ChainMap<AnnotatedEV5Transaction[]>;
}

/** Deploys and reconciles one combined LayerZero hook/ISM per mesh chain. */
export class EvmLayerZeroV2HookIsmModule {
  static protocols = [ProtocolType.Ethereum, ProtocolType.Tron];

  constructor(
    protected readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
    public readonly address: Address,
  ) {}

  read(): Promise<DerivedLayerZeroV2HookIsmConfig> {
    return new EvmLayerZeroV2HookIsmReader(
      this.multiProvider,
      this.chain,
    ).deriveLayerZeroConfig(this.address);
  }

  async update(
    targetConfig: LayerZeroV2HookIsmConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    const target = LayerZeroV2HookIsmSchema.parse(targetConfig);
    const current = await this.read();
    for (const field of [
      'type',
      'mailbox',
      'endpoint',
      'layerZeroDomainId',
    ] as const) {
      const actual = current[field];
      const desired = target[field];
      const equal =
        typeof actual === 'string' && typeof desired === 'string'
          ? eqAddress(actual, desired) || actual === desired
          : desired === undefined || actual === desired;
      assert(
        equal,
        `LayerZero hook/ISM on ${this.chain} has immutable ${field} ${actual}; target wants ${desired}`,
      );
    }

    const iface = LayerZeroV2CcipReadHookIsm__factory.createInterface();
    const callbackIface = LayerZeroV2CallbackHookIsm__factory.createInterface();
    const chainId = this.multiProvider.getEvmChainId(this.chain);
    const txs: AnnotatedEV5Transaction[] = [];
    const configUpdates: LayerZeroV2ConfigUpdate[] = [];
    const configUpdateChains: string[] = [];
    const callbackGasLimits: bigint[] = [];
    const push = (annotation: string, data: string) =>
      txs.push({ chainId, annotation, to: this.address, data });

    for (const [remoteChain, remote] of Object.entries(current.remoteRouters)) {
      const desired = target.remoteRouters[remoteChain];
      if (!desired || remote.layerZeroDomainId !== desired.layerZeroDomainId) {
        const domain = this.multiProvider.getDomainId(remoteChain);
        push(
          `Unenrolling ${remoteChain} from LayerZero hook/ISM ${this.chain}`,
          iface.encodeFunctionData('unenrollRemoteRouter', [domain]),
        );
      }
    }

    for (const [remoteChain, remote] of Object.entries(target.remoteRouters)) {
      const domain = this.multiProvider.getDomainId(remoteChain);
      const actual = current.remoteRouters[remoteChain];
      const requiresEnrollment =
        !actual ||
        actual.layerZeroDomainId !== remote.layerZeroDomainId ||
        !eqAddress(actual.sendLibrary, remote.sendLibrary) ||
        !eqAddress(actual.receiveLibrary, remote.receiveLibrary);
      if (requiresEnrollment) {
        const enrollment = remoteEnrollment(domain, remote);
        let data: string;
        if (target.type === LayerZeroV2Variant.Callback) {
          assert(
            remote.callbackGasLimit !== undefined,
            `Missing callback gas limit for ${remoteChain}`,
          );
          data = callbackIface.encodeFunctionData(
            'enrollLayerZeroRemoteRouter',
            [enrollment, remote.callbackGasLimit],
          );
        } else {
          data = iface.encodeFunctionData('enrollLayerZeroRemoteRouter', [
            enrollment,
          ]);
        }
        push(
          `Atomically enrolling ${remoteChain} on LayerZero hook/ISM ${this.chain}`,
          data,
        );
        continue;
      }
      assert(actual, `Missing current LayerZero route for ${remoteChain}`);
      const changedConfig = await this.changedLayerZeroConfigs(
        current.endpoint,
        remote,
      );
      let callbackChanged = false;
      if (target.type === LayerZeroV2Variant.Callback) {
        assert(
          remote.callbackGasLimit !== undefined,
          `Missing callback gas limit for ${remoteChain}`,
        );
        callbackChanged =
          actual.callbackGasLimit === undefined ||
          BigInt(actual.callbackGasLimit) !== BigInt(remote.callbackGasLimit);
      }
      if (
        eqAddress(actual.router, remote.router) &&
        this.receiveLibraryTimeoutMatches(actual, remote) &&
        changedConfig.sendConfig.length === 0 &&
        changedConfig.receiveConfig.length === 0 &&
        !callbackChanged
      )
        continue;

      configUpdates.push({
        domain,
        router: addressToBytes32(remote.router),
        receiveLibraryTimeout:
          remote.receiveLibraryTimeout?.library ?? constants.AddressZero,
        receiveLibraryTimeoutExpiry: remote.receiveLibraryTimeout?.expiry ?? 0,
        ...changedConfig,
      });
      configUpdateChains.push(remoteChain);
      if (target.type === LayerZeroV2Variant.Callback) {
        assert(
          remote.callbackGasLimit !== undefined,
          `Missing callback gas limit for ${remoteChain}`,
        );
        callbackGasLimits.push(remote.callbackGasLimit);
      }
    }

    if (configUpdates.length > 0) {
      const data =
        target.type === LayerZeroV2Variant.Callback
          ? callbackIface.encodeFunctionData(
              'updateLayerZeroRemoteRouterConfigs',
              [configUpdates, callbackGasLimits],
            )
          : iface.encodeFunctionData('updateLayerZeroRemoteRouterConfigs', [
              configUpdates,
            ]);
      push(
        `Atomically updating ${configUpdateChains.join(', ')} LayerZero route config on ${this.chain}`,
        data,
      );
    }

    if (
      target.type === LayerZeroV2Variant.CcipRead &&
      !deepEquals(current.urls ?? [], target.urls ?? [])
    ) {
      push(
        `Updating LayerZero CCIP-read URLs on ${this.chain}`,
        CCIP_READ_IFACE.encodeFunctionData('setUrls', [target.urls]),
      );
    }
    txs.push(
      ...transferOwnershipTransactions(
        chainId,
        this.address,
        current,
        target,
        `LayerZero hook/ISM on ${this.chain}`,
      ),
    );
    return txs;
  }

  private receiveLibraryTimeoutMatches(
    current: LayerZeroV2RemoteRouterConfig,
    target: LayerZeroV2RemoteRouterConfig,
  ): boolean {
    if (!current.receiveLibraryTimeout || !target.receiveLibraryTimeout)
      return current.receiveLibraryTimeout === target.receiveLibraryTimeout;
    return (
      eqAddress(
        current.receiveLibraryTimeout.library,
        target.receiveLibraryTimeout.library,
      ) &&
      current.receiveLibraryTimeout.expiry ===
        target.receiveLibraryTimeout.expiry
    );
  }

  private async changedLayerZeroConfigs(
    endpointAddress: Address,
    remote: LayerZeroV2RemoteRouterConfig,
  ): Promise<{
    sendConfig: LayerZeroV2ConfigParam[];
    receiveConfig: LayerZeroV2ConfigParam[];
  }> {
    const endpoint = new Contract(
      endpointAddress,
      ENDPOINT_ABI,
      this.multiProvider.getProvider(this.chain),
    );
    const result = { sendConfig: [], receiveConfig: [] } as {
      sendConfig: Array<{
        eid: number;
        configType: 1 | 2;
        config: string;
      }>;
      receiveConfig: Array<{
        eid: number;
        configType: 1 | 2;
        config: string;
      }>;
    };
    for (const [library, params, direction] of [
      [remote.sendLibrary, remote.sendConfig, 'send'],
      [remote.receiveLibrary, remote.receiveConfig, 'receive'],
    ] as const) {
      const changed = [];
      for (const param of params) {
        const actual: string = await endpoint.getConfig(
          this.address,
          library,
          remote.layerZeroDomainId,
          param.configType,
        );
        if (actual.toLowerCase() !== param.config.toLowerCase()) {
          changed.push({
            eid: remote.layerZeroDomainId,
            configType: param.configType,
            config: param.config,
          });
        }
      }
      if (changed.length > 0) {
        result[`${direction}Config`] = changed;
      }
    }
    return result;
  }

  static withDeployedRouters(
    mesh: LayerZeroV2MeshConfig,
    addresses: ChainMap<Address>,
  ): LayerZeroV2MeshConfig {
    return Object.fromEntries(
      Object.entries(mesh).map(([chain, config]) => [
        chain,
        {
          ...config,
          remoteRouters: Object.fromEntries(
            Object.entries(config.remoteRouters).map(([remote, route]) => {
              const router = addresses[remote];
              assert(
                router,
                `No deployed LayerZero router for ${remote}, enrolled by ${chain}`,
              );
              return [remote, { ...route, router }];
            }),
          ),
        },
      ]),
    );
  }

  static async deployMesh(
    multiProvider: MultiProvider,
    inputMesh: LayerZeroV2MeshConfig,
    contractVerifier?: ContractVerifier,
  ): Promise<ChainMap<Address>> {
    return (
      await this.reconcileMesh(multiProvider, inputMesh, {}, contractVerifier)
    ).addresses;
  }

  static async reconcileMesh(
    multiProvider: MultiProvider,
    inputMesh: LayerZeroV2MeshConfig,
    existingAddresses: ChainMap<Address> = {},
    contractVerifier?: ContractVerifier,
  ): Promise<LayerZeroV2MeshReconciliation> {
    const mesh = Object.fromEntries(
      Object.entries(inputMesh).map(([chain, config]) => [
        chain,
        LayerZeroV2HookIsmSchema.parse(config),
      ]),
    );
    const chains = Object.keys(mesh);
    assert(chains.length > 1, 'A LayerZero mesh needs at least two chains');
    const asymmetries = findAsymmetricLayerZeroV2Routes(mesh);
    assert(
      asymmetries.length === 0,
      `Asymmetric LayerZero mesh:\n  ${asymmetries.join('\n  ')}`,
    );

    await Promise.all(
      chains.map(async (chain) => {
        assert(
          EvmLayerZeroV2HookIsmModule.protocols.includes(
            multiProvider.getProtocol(chain),
          ),
          `LayerZero V2 hook/ISM only supports Ethereum and Tron chains; ${chain} is neither`,
        );
        const endpoint = new Contract(
          mesh[chain].endpoint,
          ENDPOINT_ABI,
          multiProvider.getProvider(chain),
        );
        const [layerZeroDomainId, nativeToken] = await Promise.all([
          endpoint.eid(),
          endpoint.nativeToken(),
        ]);
        if (mesh[chain].layerZeroDomainId !== undefined) {
          assert(
            Number(layerZeroDomainId) === mesh[chain].layerZeroDomainId,
            `${chain} Endpoint reports LayerZero domain ID ${layerZeroDomainId}; config expects ${mesh[chain].layerZeroDomainId}`,
          );
        }
        assert(
          eqAddress(nativeToken, constants.AddressZero),
          `${chain} Endpoint uses unsupported native token ${nativeToken}`,
        );
      }),
    );

    const addresses: ChainMap<Address> = {};
    const fresh = new Set<ChainName>();
    for (const chain of chains) {
      const existing = existingAddresses[chain];
      if (existing) {
        const current = await new EvmLayerZeroV2HookIsmReader(
          multiProvider,
          chain,
        ).deriveLayerZeroConfig(existing);
        const target = mesh[chain];
        if (
          current.type === target.type &&
          eqAddress(current.mailbox, target.mailbox) &&
          eqAddress(current.endpoint, target.endpoint) &&
          (target.layerZeroDomainId === undefined ||
            current.layerZeroDomainId === target.layerZeroDomainId)
        ) {
          addresses[chain] = existing;
          continue;
        }
      }
      addresses[chain] = await this.deployRouter(
        multiProvider,
        chain,
        mesh[chain],
        contractVerifier,
      );
      fresh.add(chain);
    }
    const resolved = this.withDeployedRouters(mesh, addresses);
    const transactions: ChainMap<AnnotatedEV5Transaction[]> = {};
    for (const chain of chains) {
      if (fresh.has(chain)) {
        await this.configureFreshRouter(
          multiProvider,
          chain,
          addresses[chain],
          resolved[chain],
        );
      } else {
        transactions[chain] = await new EvmLayerZeroV2HookIsmModule(
          multiProvider,
          chain,
          addresses[chain],
        ).update(resolved[chain]);
      }
    }
    return { addresses, transactions };
  }

  private static async deployRouter(
    multiProvider: MultiProvider,
    chain: ChainName,
    config: LayerZeroV2HookIsmConfig,
    contractVerifier?: ContractVerifier,
  ): Promise<Address> {
    if (config.type === LayerZeroV2Variant.Callback) {
      const router = await multiProvider.handleDeploy(
        chain,
        new LayerZeroV2CallbackHookIsm__factory(),
        [config.mailbox, config.endpoint],
      );
      await contractVerifier?.verifyContract(chain, {
        name: 'LayerZeroV2CallbackHookIsm',
        address: router.address,
        constructorArguments:
          LayerZeroV2CallbackHookIsm__factory.createInterface()
            .encodeDeploy([config.mailbox, config.endpoint])
            .replace('0x', ''),
        isProxy: false,
      });
      return router.address;
    }
    assert(config.urls, `${chain} CCIP-read LayerZero router requires URLs`);
    const router = await multiProvider.handleDeploy(
      chain,
      new LayerZeroV2CcipReadHookIsm__factory(),
      [config.mailbox, config.endpoint, config.urls],
    );
    await contractVerifier?.verifyContract(chain, {
      name: 'LayerZeroV2CcipReadHookIsm',
      address: router.address,
      constructorArguments:
        LayerZeroV2CcipReadHookIsm__factory.createInterface()
          .encodeDeploy([config.mailbox, config.endpoint, config.urls])
          .replace('0x', ''),
      isProxy: false,
    });
    return router.address;
  }

  private static async configureFreshRouter(
    multiProvider: MultiProvider,
    chain: ChainName,
    address: Address,
    config: LayerZeroV2HookIsmConfig,
  ): Promise<void> {
    const signer = multiProvider.getSigner(chain);
    const router = LayerZeroV2CcipReadHookIsm__factory.connect(address, signer);
    const overrides = multiProvider.getTransactionOverrides(chain);

    for (const [remoteChain, remote] of Object.entries(config.remoteRouters)) {
      const domain = multiProvider.getDomainId(remoteChain);
      const enrollment = remoteEnrollment(domain, remote);
      if (config.type === LayerZeroV2Variant.Callback) {
        assert(
          remote.callbackGasLimit !== undefined,
          `${chain} -> ${remoteChain} requires callback gas`,
        );
        const callback = LayerZeroV2CallbackHookIsm__factory.connect(
          address,
          signer,
        );
        await multiProvider.handleTx(
          chain,
          await callback.enrollLayerZeroRemoteRouter(
            enrollment,
            remote.callbackGasLimit,
            overrides,
          ),
        );
      } else {
        await multiProvider.handleTx(
          chain,
          await router.enrollLayerZeroRemoteRouter(enrollment, overrides),
        );
      }
    }
    if (!eqAddress(await router.owner(), config.owner)) {
      await multiProvider.handleTx(
        chain,
        await router.transferOwnership(config.owner, overrides),
      );
    }
  }
}
