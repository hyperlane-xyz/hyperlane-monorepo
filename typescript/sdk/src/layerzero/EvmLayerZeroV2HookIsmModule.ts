import { LayerZeroV2HookIsm__factory } from '@hyperlane-xyz/core';
import type { LayerZeroV2HookIsm } from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  addressToBytes32,
  assert,
  eqAddress,
  deepEquals,
} from '@hyperlane-xyz/utils';
import { Contract, constants } from 'ethers';

import { resolveRemoteDomainId } from '../combinedHookIsm/remoteDomain.js';
import { transferOwnershipTransactions } from '../contracts/contracts.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainMap, ChainName } from '../types.js';

import { EvmLayerZeroV2HookIsmReader } from './EvmLayerZeroV2HookIsmReader.js';
import {
  encodeLayerZeroV2ExecutorConfig,
  encodeLayerZeroV2UlnConfig,
  layerZeroV2ReceiveConfigParams,
  layerZeroV2SendConfigParams,
} from './configCodec.js';
import {
  DerivedLayerZeroV2HookIsmConfig,
  LayerZeroV2HookIsmConfig,
  LayerZeroV2HookIsmSchema,
  LayerZeroV2MeshConfig,
  findAsymmetricLayerZeroV2Routes,
  LayerZeroV2RemoteRouterConfig,
} from './types.js';

const ENDPOINT_ABI = [
  'function eid() view returns (uint32)',
  'function nativeToken() view returns (address)',
];
// The inherited `enrollRemoteRouters(uint32[],bytes32[])` overload reverts.
const ENROLL_REMOTE_ROUTERS =
  'enrollRemoteRouters((uint32,bytes32,uint32,address,address,(uint32,address),(uint64,uint8,uint8,uint8,address[],address[]),(uint64,uint8,uint8,uint8,address[],address[]))[])';

function remoteEnrollment(
  domainId: number,
  remote: LayerZeroV2RemoteRouterConfig,
): LayerZeroV2HookIsm.RemoteRouterConfigStruct {
  const { executorConfig, sendUlnConfig } = layerZeroV2SendConfigParams(
    remote.sendConfig,
  );
  const { receiveUlnConfig } = layerZeroV2ReceiveConfigParams(
    remote.receiveConfig,
  );
  return {
    domainId,
    domainIsm: addressToBytes32(remote.router),
    endpointId: remote.layerZeroDomainId,
    sendLibrary: remote.sendLibrary,
    receiveLibrary: remote.receiveLibrary,
    executorConfig,
    sendUlnConfig,
    receiveUlnConfig,
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
    for (const field of ['mailbox', 'endpoint', 'layerZeroDomainId'] as const) {
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

    const iface = LayerZeroV2HookIsm__factory.createInterface();
    const chainId = this.multiProvider.getEvmChainId(this.chain);
    const txs: AnnotatedEV5Transaction[] = [];
    const enrollments: LayerZeroV2HookIsm.RemoteRouterConfigStruct[] = [];
    const enrollmentChains: string[] = [];
    const push = (annotation: string, data: string) =>
      txs.push({ chainId, annotation, to: this.address, data });

    for (const [remoteChain, remote] of Object.entries(current.remoteRouters)) {
      const desired = target.remoteRouters[remoteChain];
      if (!desired || remote.layerZeroDomainId !== desired.layerZeroDomainId) {
        const domain = resolveRemoteDomainId(
          this.multiProvider,
          remoteChain,
          this.chain,
        );
        push(
          `Unenrolling ${remoteChain} from LayerZero hook/ISM ${this.chain}`,
          iface.encodeFunctionData('unenrollRemoteRouter', [domain]),
        );
      }
    }

    for (const [remoteChain, remote] of Object.entries(target.remoteRouters)) {
      const actual = current.remoteRouters[remoteChain];
      if (actual && this.remoteRouterMatches(actual, remote)) continue;
      enrollments.push(
        remoteEnrollment(
          resolveRemoteDomainId(this.multiProvider, remoteChain, this.chain),
          remote,
        ),
      );
      enrollmentChains.push(remoteChain);
    }

    if (enrollments.length > 0) {
      push(
        `Atomically enrolling ${enrollmentChains.join(', ')} on LayerZero hook/ISM ${this.chain}`,
        iface.encodeFunctionData(ENROLL_REMOTE_ROUTERS, [enrollments]),
      );
    }

    if (!deepEquals(current.urls, target.urls)) {
      push(
        `Updating LayerZero CCIP-read URLs on ${this.chain}`,
        iface.encodeFunctionData('setUrls', [target.urls]),
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

  /**
   * Every enrollment rewrites the complete route and policy, so any difference
   * re-enrolls the route with all of its desired values.
   */
  private remoteRouterMatches(
    current: LayerZeroV2RemoteRouterConfig,
    target: LayerZeroV2RemoteRouterConfig,
  ): boolean {
    return (
      eqAddress(current.router, target.router) &&
      current.layerZeroDomainId === target.layerZeroDomainId &&
      eqAddress(current.sendLibrary, target.sendLibrary) &&
      eqAddress(current.receiveLibrary, target.receiveLibrary) &&
      encodeLayerZeroV2ExecutorConfig(current.sendConfig.executor) ===
        encodeLayerZeroV2ExecutorConfig(target.sendConfig.executor) &&
      encodeLayerZeroV2UlnConfig(current.sendConfig.uln) ===
        encodeLayerZeroV2UlnConfig(target.sendConfig.uln) &&
      encodeLayerZeroV2UlnConfig(current.receiveConfig.uln) ===
        encodeLayerZeroV2UlnConfig(target.receiveConfig.uln)
    );
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

  static async readMesh(
    multiProvider: MultiProvider,
    addresses: ChainMap<Address>,
  ): Promise<ChainMap<DerivedLayerZeroV2HookIsmConfig>> {
    const entries = await Promise.all(
      Object.entries(addresses).map(async ([chain, address]) => [
        chain,
        await new EvmLayerZeroV2HookIsmReader(
          multiProvider,
          chain,
        ).deriveLayerZeroConfig(address),
      ]),
    );
    return Object.fromEntries(entries);
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
    const router = await multiProvider.handleDeploy(
      chain,
      new LayerZeroV2HookIsm__factory(),
      [config.mailbox, config.endpoint, config.urls],
    );
    await contractVerifier?.verifyContract(chain, {
      name: 'LayerZeroV2HookIsm',
      address: router.address,
      constructorArguments: LayerZeroV2HookIsm__factory.createInterface()
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
    const router = LayerZeroV2HookIsm__factory.connect(address, signer);
    const overrides = multiProvider.getTransactionOverrides(chain);

    const enrollments = Object.entries(config.remoteRouters).map(
      ([remoteChain, remote]) =>
        remoteEnrollment(multiProvider.getDomainId(remoteChain), remote),
    );
    await multiProvider.handleTx(
      chain,
      await router[ENROLL_REMOTE_ROUTERS](enrollments, overrides),
    );
    if (!eqAddress(await router.owner(), config.owner)) {
      await multiProvider.handleTx(
        chain,
        await router.transferOwnership(config.owner, overrides),
      );
    }
  }
}
