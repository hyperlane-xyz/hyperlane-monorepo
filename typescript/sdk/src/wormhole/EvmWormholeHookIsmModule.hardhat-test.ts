import chai from 'chai';
import hre from 'hardhat';

import {
  MockCustomConsistencyLevel__factory,
  MockExecutorQuoterRouter__factory,
  MockWormholeCore__factory,
  Mailbox__factory,
  WormholeExecutorHookIsm__factory,
  WormholeVaaHookIsm__factory,
} from '@hyperlane-xyz/core';

import { test4 } from '../consts/testChains.js';
import { HookType } from '../hook/types.js';
import { IsmType } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmWormholeHookIsmModule } from './EvmWormholeHookIsmModule.js';
import {
  WormholeWarpChainConfig,
  buildWormholeMeshConfig,
  materializeWormholeWarpConfig,
  pairWormholeConfigs,
} from './config.js';
import { WormholeConsistencyType, WormholeVariant } from './types.js';
import {
  WormholeConsistencyLevel,
  type WormholeConsistencyLevelConfig,
} from './consistency.js';
import { assert } from '@hyperlane-xyz/utils';

const { expect } = chai;

describe('EvmWormholeHookIsmModule', () => {
  const chains = ['wormholea', 'wormholeb'];
  const wormholeChainIds: Record<string, number> = {
    wormholea: 4_001,
    wormholeb: 4_002,
  };

  let multiProvider: MultiProvider;
  let signerAddress: string;
  let mailboxes: Record<string, string>;
  let cores: Record<string, string>;
  let customConsistencyLevels: Record<string, string>;
  let quoterRouters: Record<string, string>;

  before(async () => {
    const [signer] = await hre.ethers.getSigners();
    signerAddress = signer.address;
    multiProvider = new MultiProvider({
      wormholea: { ...test4, name: 'wormholea', domainId: 10_001 },
      wormholeb: { ...test4, name: 'wormholeb', domainId: 10_002 },
    });
    multiProvider.setProvider('wormholea', hre.ethers.provider);
    multiProvider.setProvider('wormholeb', hre.ethers.provider);
    multiProvider.setSharedSigner(signer);

    mailboxes = {};
    cores = {};
    customConsistencyLevels = {};
    quoterRouters = {};
    for (const chain of chains) {
      mailboxes[chain] = (
        await multiProvider.handleDeploy(chain, new Mailbox__factory(), [
          multiProvider.getDomainId(chain),
        ])
      ).address;
      cores[chain] = (
        await multiProvider.handleDeploy(
          chain,
          new MockWormholeCore__factory(),
          [wormholeChainIds[chain], 0],
        )
      ).address;
      customConsistencyLevels[chain] = (
        await multiProvider.handleDeploy(
          chain,
          new MockCustomConsistencyLevel__factory(),
          [],
        )
      ).address;
      quoterRouters[chain] = (
        await multiProvider.handleDeploy(
          chain,
          new MockExecutorQuoterRouter__factory(),
          [0],
        )
      ).address;
    }
  });

  function routeConfig(
    variant: WormholeVariant,
    consistencyLevel: WormholeConsistencyLevelConfig = {
      type: WormholeConsistencyType.Finalized,
    },
  ): Record<string, WormholeWarpChainConfig> {
    return Object.fromEntries(
      chains.map((chain) => {
        const remote = chains.find((candidate) => candidate !== chain);
        assert(remote, `Missing remote chain for ${chain}`);
        return [
          chain,
          {
            mailbox: mailboxes[chain],
            hook:
              variant === WormholeVariant.Executor
                ? {
                    type: HookType.WORMHOLE_EXECUTOR,
                    executorQuoterRouter: quoterRouters[chain],
                    routes: {
                      [remote]: {
                        quoter: signerAddress,
                        callbackGasLimit: 400_000n,
                      },
                    },
                  }
                : { type: HookType.WORMHOLE_VAA },
            interchainSecurityModule:
              variant === WormholeVariant.Executor
                ? {
                    type: IsmType.WORMHOLE_EXECUTOR,
                    owner: signerAddress,
                    core: cores[chain],
                    wormholeChainId: wormholeChainIds[chain],
                    consistencyLevel,
                  }
                : {
                    type: IsmType.WORMHOLE_VAA,
                    owner: signerAddress,
                    core: cores[chain],
                    wormholeChainId: wormholeChainIds[chain],
                    consistencyLevel,
                    urls: ['https://example.com/{data}'],
                  },
          },
        ];
      }),
    );
  }

  for (const variant of [WormholeVariant.Executor, WormholeVariant.DirectVaa]) {
    it(`deploys ${variant} with custom consistency`, async () => {
      const input = routeConfig(variant, {
        type: WormholeConsistencyType.Custom,
        address: customConsistencyLevels.wormholea,
        baseConsistencyLevel: WormholeConsistencyType.Instant,
        additionalBlocks: 2,
      });
      for (const chain of chains) {
        const ism = input[chain].interchainSecurityModule;
        assert(
          ism && typeof ism !== 'string' && 'consistencyLevel' in ism,
          `Missing Wormhole ISM on ${chain}`,
        );
        ism.consistencyLevel = {
          type: WormholeConsistencyType.Custom,
          address: customConsistencyLevels[chain],
          baseConsistencyLevel: WormholeConsistencyType.Instant,
          additionalBlocks: 2,
        };
      }

      const mesh = buildWormholeMeshConfig(input, pairWormholeConfigs(input));
      const addresses = await EvmWormholeHookIsmModule.deployMesh(
        multiProvider,
        mesh,
      );

      for (const chain of chains) {
        const router = WormholeVaaHookIsm__factory.connect(
          addresses[chain],
          multiProvider.getProvider(chain),
        );
        expect(await router.consistencyLevel()).to.equal(
          WormholeConsistencyLevel.Custom,
        );
        expect(await router.customConsistencyLevel()).to.equal(
          customConsistencyLevels[chain],
        );
        expect(await router.baseConsistencyLevel()).to.equal(
          WormholeConsistencyLevel.Instant,
        );
        expect(await router.additionalBlocks()).to.equal(2);
      }
    });
  }

  for (const variant of [WormholeVariant.Executor, WormholeVariant.DirectVaa]) {
    it(`deploys, enrolls, materializes, and reuses a ${variant} mesh`, async () => {
      const input = routeConfig(variant);
      const mesh = buildWormholeMeshConfig(input, pairWormholeConfigs(input));
      const addresses = await EvmWormholeHookIsmModule.deployMesh(
        multiProvider,
        mesh,
      );
      const materialized = materializeWormholeWarpConfig(input, addresses);

      for (const chain of chains) {
        const remote = chains.find((candidate) => candidate !== chain);
        assert(remote, `Missing remote chain for ${chain}`);
        expect(materialized[chain].hook).to.equal(addresses[chain]);
        expect(materialized[chain].interchainSecurityModule).to.equal(
          addresses[chain],
        );

        const contract =
          variant === WormholeVariant.Executor
            ? WormholeExecutorHookIsm__factory.connect(
                addresses[chain],
                multiProvider.getProvider(chain),
              )
            : WormholeVaaHookIsm__factory.connect(
                addresses[chain],
                multiProvider.getProvider(chain),
              );
        expect(
          await contract.routers(multiProvider.getDomainId(remote)),
        ).to.not.equal(hre.ethers.constants.HashZero);
      }

      const second = await EvmWormholeHookIsmModule.reconcileMesh(
        multiProvider,
        mesh,
        addresses,
      );
      expect(second.addresses).to.deep.equal(addresses);
      expect(Object.values(second.transactions).flat()).to.deep.equal([]);
    });
  }

  it('returns owner-authorized mutable updates for a reused direct-VAA mesh', async () => {
    const input = routeConfig(WormholeVariant.DirectVaa);
    const mesh = buildWormholeMeshConfig(input, pairWormholeConfigs(input));
    const addresses = await EvmWormholeHookIsmModule.deployMesh(
      multiProvider,
      mesh,
    );
    for (const chain of chains)
      mesh[chain].urls = ['https://new.example/{data}'];

    const result = await EvmWormholeHookIsmModule.reconcileMesh(
      multiProvider,
      mesh,
      addresses,
    );
    expect(
      Object.values(result.transactions).every((txs) => txs.length === 1),
    ).to.equal(true);

    for (const chain of chains) {
      for (const transaction of result.transactions[chain]) {
        await multiProvider.sendTransaction(chain, transaction);
      }
      expect(
        await WormholeVaaHookIsm__factory.connect(
          addresses[chain],
          multiProvider.getProvider(chain),
        ).urls(),
      ).to.deep.equal(['https://new.example/{data}']);
    }
  });

  it('redeploys when an immutable changes', async () => {
    const input = routeConfig(WormholeVariant.DirectVaa);
    const mesh = buildWormholeMeshConfig(input, pairWormholeConfigs(input));
    const addresses = await EvmWormholeHookIsmModule.deployMesh(
      multiProvider,
      mesh,
    );
    for (const chain of chains) {
      mesh[chain].consistencyLevel = {
        type: WormholeConsistencyType.Instant,
      };
      for (const remote of Object.values(mesh[chain].remoteRouters)) {
        remote.expectedConsistencyLevel = WormholeConsistencyLevel.Instant;
      }
    }

    const result = await EvmWormholeHookIsmModule.reconcileMesh(
      multiProvider,
      mesh,
      addresses,
    );
    for (const chain of chains) {
      expect(result.addresses[chain]).to.not.equal(addresses[chain]);
    }
    expect(Object.values(result.transactions).flat()).to.deep.equal([]);
  });
});
