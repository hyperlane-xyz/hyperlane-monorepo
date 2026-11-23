import { expect } from 'chai';

import { HookConfig, HookType } from '../hook/types.js';
import { IsmConfig, IsmType } from '../ism/types.js';
import { LAYER_ZERO_V2_LEAF_MATCHER } from '../layerzero/config.js';
import { LayerZeroV2ConfigMode } from '../layerzero/types.js';
import { ChainMap } from '../types.js';
import { WORMHOLE_LEAF_MATCHER } from '../wormhole/config.js';
import { WormholeConsistencyType } from '../wormhole/types.js';

import {
  CombinedHookIsmLeafMatcher,
  CombinedHookIsmWarpChainConfig,
  materializeCombinedHookIsmWarpConfig,
  pairCombinedHookIsmConfigs,
} from './config.js';

const OWNER = '0x0000000000000000000000000000000000000001';
const MAILBOX = '0x0000000000000000000000000000000000000002';
const PROTOCOL_CONTRACT = '0x0000000000000000000000000000000000000003';
const LIBRARY = '0x0000000000000000000000000000000000000004';
const CHAIN_A_ROUTER = '0x00000000000000000000000000000000000000a1';
const CHAIN_B_ROUTER = '0x00000000000000000000000000000000000000b1';
const URLS = ['https://example.com/{data}'];
const CHAIN_A = 'chaina';
const CHAIN_B = 'chainb';

interface ProtocolCase {
  label: string;
  matcher: CombinedHookIsmLeafMatcher<HookConfig, IsmConfig>;
  hookLeaf: () => HookConfig;
  ismLeaf: (remote: string) => IsmConfig;
}

const protocols: ProtocolCase[] = [
  {
    label: 'Wormhole',
    matcher: WORMHOLE_LEAF_MATCHER,
    hookLeaf: () => ({ type: HookType.WORMHOLE }),
    ismLeaf: () => ({
      type: IsmType.WORMHOLE,
      owner: OWNER,
      core: PROTOCOL_CONTRACT,
      wormholeChainId: 2,
      consistencyLevel: { type: WormholeConsistencyType.Finalized },
      urls: URLS,
    }),
  },
  {
    label: 'LayerZero',
    matcher: LAYER_ZERO_V2_LEAF_MATCHER,
    hookLeaf: () => ({ type: HookType.LAYER_ZERO_V2 }),
    ismLeaf: (remote) => ({
      type: IsmType.LAYER_ZERO_V2,
      owner: OWNER,
      endpoint: PROTOCOL_CONTRACT,
      layerZeroDomainId: 30_101,
      urls: URLS,
      pathways: {
        [remote]: {
          layerZeroDomainId: 30_110,
          sendLibrary: LIBRARY,
          receiveLibrary: LIBRARY,
          sendConfig: {
            executor: { type: LayerZeroV2ConfigMode.Default },
            uln: { type: LayerZeroV2ConfigMode.Default },
          },
          receiveConfig: { uln: { type: LayerZeroV2ConfigMode.Default } },
        },
      },
    }),
  },
];

function aggregationHook(protocol: ProtocolCase): HookConfig {
  return {
    type: HookType.AGGREGATION,
    hooks: [{ type: HookType.MAILBOX_DEFAULT }, protocol.hookLeaf()],
  };
}

function aggregationIsm(protocol: ProtocolCase): IsmConfig {
  return {
    type: IsmType.AGGREGATION,
    threshold: 2,
    modules: [{ type: IsmType.TEST_ISM }, protocol.ismLeaf(CHAIN_B)],
  };
}

function route(
  protocol: ProtocolCase,
  chainA: CombinedHookIsmWarpChainConfig = {
    mailbox: MAILBOX,
    hook: aggregationHook(protocol),
    interchainSecurityModule: aggregationIsm(protocol),
  },
): ChainMap<CombinedHookIsmWarpChainConfig> {
  return {
    [CHAIN_A]: chainA,
    [CHAIN_B]: {
      mailbox: MAILBOX,
      hook: protocol.hookLeaf(),
      interchainSecurityModule: protocol.ismLeaf(CHAIN_A),
    },
  };
}

interface NestedIsmCase {
  name: string;
  wrap: (ism: IsmConfig) => IsmConfig;
}

const nestedCases: NestedIsmCase[] = [
  {
    name: 'an aggregation ISM',
    wrap: (ism) => ({
      type: IsmType.AGGREGATION,
      threshold: 1,
      modules: [ism],
    }),
  },
  {
    name: 'a routing ISM',
    wrap: (ism) => ({
      type: IsmType.ROUTING,
      owner: OWNER,
      domains: { [CHAIN_B]: ism },
    }),
  },
];

for (const protocol of protocols) {
  describe(`combined hook/ISM config with the ${protocol.label} matcher`, () => {
    it('replaces both leaves with the same local address', () => {
      const result = materializeCombinedHookIsmWarpConfig(
        protocol.matcher,
        route(protocol),
        { [CHAIN_A]: CHAIN_A_ROUTER, [CHAIN_B]: CHAIN_B_ROUTER },
      );

      expect(result[CHAIN_A].hook).to.deep.equal({
        type: HookType.AGGREGATION,
        hooks: [{ type: HookType.MAILBOX_DEFAULT }, CHAIN_A_ROUTER],
      });
      expect(result[CHAIN_A].interchainSecurityModule).to.deep.equal({
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [{ type: IsmType.TEST_ISM }, CHAIN_A_ROUTER],
      });
      expect(result[CHAIN_B].hook).to.equal(CHAIN_B_ROUTER);
      expect(result[CHAIN_B].interchainSecurityModule).to.equal(CHAIN_B_ROUTER);
    });

    it('requires a deployed address for every chain', () => {
      expect(() =>
        materializeCombinedHookIsmWarpConfig(
          protocol.matcher,
          route(protocol),
          { [CHAIN_A]: CHAIN_A_ROUTER },
        ),
      ).to.throw(`Missing deployed ${protocol.label} router for ${CHAIN_B}`);
    });

    it('requires both leaves on every participating chain', () => {
      const config = route(protocol, {
        mailbox: MAILBOX,
        interchainSecurityModule: aggregationIsm(protocol),
      });

      expect(() =>
        pairCombinedHookIsmConfigs(protocol.matcher, config),
      ).to.throw(
        `${CHAIN_A} must contain exactly one ${protocol.label} hook leaf; found 0`,
      );
    });

    it(`rejects duplicate ${protocol.label} leaves`, () => {
      const config = route(protocol, {
        mailbox: MAILBOX,
        hook: {
          type: HookType.AGGREGATION,
          hooks: [protocol.hookLeaf(), protocol.hookLeaf()],
        },
        interchainSecurityModule: aggregationIsm(protocol),
      });

      expect(() =>
        pairCombinedHookIsmConfigs(protocol.matcher, config),
      ).to.throw(
        `${CHAIN_A} must contain exactly one ${protocol.label} hook leaf; found 2`,
      );
    });

    it('rejects a directional pairing mismatch', () => {
      const config = route(protocol, {
        mailbox: MAILBOX,
        hook: {
          type: HookType.ROUTING,
          owner: OWNER,
          domains: { [CHAIN_A]: protocol.hookLeaf() },
        },
        interchainSecurityModule: aggregationIsm(protocol),
      });

      expect(() =>
        pairCombinedHookIsmConfigs(protocol.matcher, config),
      ).to.throw(
        `${protocol.label} pairing mismatch for ${CHAIN_A} -> ${CHAIN_B}: origin hook=false, destination ISM=true`,
      );
    });

    for (const { name, wrap } of nestedCases) {
      it(`pairs a ${protocol.label} ISM nested in ${name}`, () => {
        const ism = protocol.ismLeaf(CHAIN_B);
        const config = route(protocol, {
          mailbox: MAILBOX,
          hook: aggregationHook(protocol),
          interchainSecurityModule: wrap(ism),
        });

        const pairs = pairCombinedHookIsmConfigs(protocol.matcher, config);
        const result = materializeCombinedHookIsmWarpConfig(
          protocol.matcher,
          config,
          { [CHAIN_A]: CHAIN_A_ROUTER, [CHAIN_B]: CHAIN_B_ROUTER },
        );

        expect(pairs[CHAIN_A].ism).to.equal(ism);
        expect(result[CHAIN_A].interchainSecurityModule).to.deep.equal(
          wrap(CHAIN_A_ROUTER),
        );
      });
    }
  });
}
