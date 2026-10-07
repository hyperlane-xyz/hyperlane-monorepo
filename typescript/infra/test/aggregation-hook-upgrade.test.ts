import { expect } from 'chai';
import { constants, providers, utils } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { PartialRegistry } from '@hyperlane-xyz/registry';
import type { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainTechnicalStack,
  ContractVerificationInput,
  MultiProvider,
  OnchainHookType,
  testChainMetadata,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts.js';
import {
  ChainExport,
  ChainExportUpdate,
  createFileExportStore,
  createMemoryExportStore,
  mergeChainExport,
} from '../src/aggregation-hook-upgrade/address-export.js';
import { readChainState } from '../src/aggregation-hook-upgrade/discovery.js';
import { checkEligibility } from '../src/aggregation-hook-upgrade/eligibility.js';
import {
  aggregatorKey,
  assertChildrenPreserved,
  buildProdTargets,
  buildShadowTargets,
  chunkRoutes,
  diffRoutes,
  isFixedVersion,
  planChain,
} from '../src/aggregation-hook-upgrade/plan.js';
import { createUpgradeMultiProvider } from '../src/aggregation-hook-upgrade/provider.js';
import type { ChainReader } from '../src/aggregation-hook-upgrade/reader.js';
import {
  REDACTED_HOST,
  REDACTED_URL,
  describeError,
  redactSecrets,
} from '../src/aggregation-hook-upgrade/redact.js';
import { buildRegistryAddresses } from '../src/aggregation-hook-upgrade/registry.js';
import { runUpgrade } from '../src/aggregation-hook-upgrade/run.js';
import {
  FORK_LABEL,
  computeExitCode,
  shadowSnippets,
} from '../src/aggregation-hook-upgrade/summary.js';
import {
  ChainDomain,
  ChainOutcome,
  ChainResult,
  ChainState,
  SkipReason,
  UpgradePhase,
} from '../src/aggregation-hook-upgrade/types.js';
import { writeVerificationInputsToFile } from '../src/deployment/verification-inputs.js';
import { Owner } from '../src/governance.js';
import { Role } from '../src/roles.js';

const addr = (n: number): Address =>
  utils.getAddress(utils.hexZeroPad(utils.hexlify(n), 20));

const ORIGIN_DOMAIN = 1;
const MAILBOX = addr(0x100);
const ROUTING = addr(0x101);
const FACTORY = addr(0x102);
const OWNER = addr(0x103);
const FALLBACK = addr(0x104);
const PAUSABLE = addr(0x300);
const MERKLE = addr(0x301);
const IGP = addr(0x302);
const AGG_LEGACY = addr(0x200);
const AGG_LEGACY_REORDERED = addr(0x201);
const AGG_FIXED = addr(0x202);
const AGG_LEGACY_B = addr(0x203);
const NON_AGG = addr(0x400);
const UNKNOWN_HOOK = addr(0x401);

const SUPPORTED: ChainDomain[] = [
  { chain: 'origin', domainId: ORIGIN_DOMAIN },
  { chain: 'chaina', domainId: 2 },
  { chain: 'chainb', domainId: 3 },
  { chain: 'chainc', domainId: 4 },
];
const REGISTRY_DOMAIN_IDS = [1, 2, 3, 4, 5, 6];

interface FakeSpec {
  defaultHook: Address;
  hookTypes: Record<string, number>;
  routes: Record<number, Address>;
  children: Record<string, Address[]>;
  versions: Record<string, string>;
  failHookType?: Address;
}

const key = (address: Address) => address.toLowerCase();

function callException(): Error {
  return Object.assign(new Error('call reverted'), {
    code: 'CALL_EXCEPTION',
    data: '0x',
  });
}

function baseSpec(): FakeSpec {
  return {
    defaultHook: ROUTING,
    hookTypes: {
      [key(ROUTING)]: OnchainHookType.FALLBACK_ROUTING,
      [key(AGG_LEGACY)]: OnchainHookType.AGGREGATION,
      [key(AGG_LEGACY_REORDERED)]: OnchainHookType.AGGREGATION,
      [key(AGG_FIXED)]: OnchainHookType.AGGREGATION,
      [key(AGG_LEGACY_B)]: OnchainHookType.AGGREGATION,
      [key(NON_AGG)]: OnchainHookType.MERKLE_TREE,
    },
    routes: {
      2: AGG_LEGACY,
      3: AGG_LEGACY,
      4: AGG_LEGACY,
      5: AGG_LEGACY_B,
      6: AGG_LEGACY_B,
    },
    children: {
      [key(AGG_LEGACY)]: [PAUSABLE, MERKLE, IGP],
      [key(AGG_LEGACY_REORDERED)]: [MERKLE, PAUSABLE, IGP],
      [key(AGG_FIXED)]: [PAUSABLE, MERKLE, IGP],
      [key(AGG_LEGACY_B)]: [addr(0x310), addr(0x311), addr(0x312)],
    },
    versions: {
      [key(FACTORY)]: '9.0.10',
      [key(AGG_LEGACY)]: '9.0.10',
      [key(AGG_LEGACY_REORDERED)]: '9.0.10',
      [key(AGG_FIXED)]: '12.2.0',
      [key(AGG_LEGACY_B)]: '5.3.9',
    },
  };
}

function fakeReader(spec: FakeSpec): ChainReader {
  return {
    defaultHook: async () => spec.defaultHook,
    hookType: async (hook) => {
      if (spec.failHookType && key(spec.failHookType) === key(hook)) {
        throw Object.assign(new Error('rate limited'), {
          code: 'SERVER_ERROR',
        });
      }
      const hookType = spec.hookTypes[key(hook)];
      if (hookType === undefined) throw callException();
      return hookType;
    },
    routingOwner: async () => OWNER,
    routingFallback: async () => FALLBACK,
    routedHook: async (_routing, domainId) =>
      spec.routes[domainId] ?? constants.AddressZero,
    aggregationChildren: async (aggregator) => {
      const children = spec.children[key(aggregator)];
      if (!children) throw new Error(`no children for ${aggregator}`);
      return children;
    },
    packageVersion: async (address) => {
      const version = spec.versions[key(address)];
      if (!version) throw new Error(`no version for ${address}`);
      return version;
    },
  };
}

async function stateFor(
  spec: FakeSpec,
  registryAggregationHook?: Address,
): Promise<ChainState> {
  const result = await readChainState({
    chain: 'origin',
    originDomainId: ORIGIN_DOMAIN,
    mailbox: MAILBOX,
    factory: FACTORY,
    registryAggregationHook,
    supportedDomains: SUPPORTED,
    registryDomainIds: REGISTRY_DOMAIN_IDS,
    reader: fakeReader(spec),
    concurrency: 4,
  });
  if (!('state' in result)) {
    throw new Error(`expected state, got skip ${result.skip}`);
  }
  return result.state;
}

describe('aggregation hook upgrade', () => {
  describe('isFixedVersion', () => {
    interface Case {
      version: string;
      fixed: boolean;
    }
    const cases: Case[] = [
      { version: '5.3.9', fixed: false },
      { version: '9.0.10', fixed: false },
      { version: '11.0.0', fixed: false },
      { version: '11.0.1', fixed: true },
      { version: '12.2.0', fixed: true },
    ];
    for (const c of cases) {
      it(`${c.version} is ${c.fixed ? 'fixed' : 'legacy'}`, () => {
        expect(isFixedVersion(c.version)).to.equal(c.fixed);
      });
    }
  });

  describe('checkEligibility', () => {
    const addresses: ChainAddresses = {
      mailbox: MAILBOX,
      staticAggregationHookFactory: FACTORY,
    };
    const skipLists = {
      legacyCoreHookRecoveryChains: ['legacychain'],
      chainsToSkip: ['skippedchain'],
    };
    interface Case {
      name: string;
      chain: string;
      protocol: ProtocolType;
      technicalStack?: ChainTechnicalStack;
      addresses?: ChainAddresses;
      reason?: SkipReason;
    }
    const cases: Case[] = [
      {
        name: 'accepts an EVM chain with factory and mailbox',
        chain: 'evmchain',
        protocol: ProtocolType.Ethereum,
        addresses,
      },
      {
        name: 'skips tron',
        chain: 'tronchain',
        protocol: ProtocolType.Tron,
        addresses,
        reason: SkipReason.Tron,
      },
      {
        name: 'skips non-EVM protocols',
        chain: 'svmchain',
        protocol: ProtocolType.Sealevel,
        addresses,
        reason: SkipReason.NonEvm,
      },
      {
        name: 'skips zksync stack chains',
        chain: 'zkchain',
        protocol: ProtocolType.Ethereum,
        technicalStack: ChainTechnicalStack.ZkSync,
        addresses,
        reason: SkipReason.ZkSyncStack,
      },
      {
        name: 'skips legacy core hook recovery chains',
        chain: 'legacychain',
        protocol: ProtocolType.Ethereum,
        addresses,
        reason: SkipReason.LegacyCoreHookRecovery,
      },
      {
        name: 'skips chainsToSkip',
        chain: 'skippedchain',
        protocol: ProtocolType.Ethereum,
        addresses,
        reason: SkipReason.ChainsToSkip,
      },
      {
        name: 'skips chains without a registry factory',
        chain: 'evmchain',
        protocol: ProtocolType.Ethereum,
        addresses: { mailbox: MAILBOX },
        reason: SkipReason.NoRegistryFactory,
      },
      {
        name: 'skips chains without a registry mailbox',
        chain: 'evmchain',
        protocol: ProtocolType.Ethereum,
        addresses: { staticAggregationHookFactory: FACTORY },
        reason: SkipReason.NoMailbox,
      },
    ];
    for (const c of cases) {
      it(c.name, () => {
        const result = checkEligibility(
          {
            chain: c.chain,
            protocol: c.protocol,
            technicalStack: c.technicalStack,
            addresses: c.addresses,
          },
          skipLists,
        );
        if (c.reason === undefined) {
          expect(result).to.deep.equal({
            eligible: true,
            mailbox: MAILBOX,
            factory: FACTORY,
          });
        } else {
          expect(result.eligible).to.equal(false);
          expect(!result.eligible && result.reason).to.equal(c.reason);
        }
      });
    }
  });

  describe('readChainState', () => {
    it('evaluates only the supported domain universe and counts ignored domains', async () => {
      const state = await stateFor(baseSpec());
      expect(state.routes.map((route) => route.domain.domainId)).to.deep.equal([
        2, 3, 4,
      ]);
      expect(state.ignored).to.deep.equal({ mapped: 2, legacyAggregator: 2 });
      const plan = planChain(state, UpgradePhase.Prod);
      expect(plan.migrations.map((m) => m.domain.domainId)).to.deep.equal([
        2, 3, 4,
      ]);
      expect(plan.sets).to.have.length(1);
      expect(plan.sets[0].children).to.deep.equal([PAUSABLE, MERKLE, IGP]);
    });

    it('is up to date when supported domains are fixed even if ignored domains are legacy', async () => {
      const spec = baseSpec();
      spec.versions[key(FACTORY)] = '12.2.0';
      spec.routes = {
        2: AGG_FIXED,
        3: AGG_FIXED,
        4: AGG_FIXED,
        5: AGG_LEGACY_B,
      };
      const state = await stateFor(spec);
      expect(state.ignored).to.deep.equal({ mapped: 1, legacyAggregator: 1 });
      for (const phase of Object.values(UpgradePhase)) {
        const plan = planChain(state, phase);
        expect(plan.upToDate).to.equal(true);
        expect(plan.migrations).to.have.length(0);
        expect(plan.fixedRoutes).to.equal(3);
      }
    });

    it('reports unmapped, non-aggregation and unknown supported domains', async () => {
      const spec = baseSpec();
      spec.routes = {
        2: AGG_LEGACY,
        3: NON_AGG,
        4: UNKNOWN_HOOK,
      };
      const state = await stateFor(spec);
      const plan = planChain(state, UpgradePhase.Prod);
      expect(plan.nonAggregation).to.deep.equal([
        {
          domain: { chain: 'chainb', domainId: 3 },
          hook: NON_AGG,
          hookType: OnchainHookType.MERKLE_TREE,
        },
        { domain: { chain: 'chainc', domainId: 4 }, hook: UNKNOWN_HOOK },
      ]);

      spec.routes = { 2: AGG_LEGACY };
      const withUnmapped = await stateFor(spec);
      expect(withUnmapped.unmapped.map((d) => d.chain)).to.deep.equal([
        'chainb',
        'chainc',
      ]);
    });

    it('skips when the default hook is not a fallback routing hook', async () => {
      const spec = baseSpec();
      spec.hookTypes[key(ROUTING)] = OnchainHookType.AGGREGATION;
      const result = await readChainState({
        chain: 'origin',
        originDomainId: ORIGIN_DOMAIN,
        mailbox: MAILBOX,
        factory: FACTORY,
        supportedDomains: SUPPORTED,
        registryDomainIds: REGISTRY_DOMAIN_IDS,
        reader: fakeReader(spec),
        concurrency: 4,
      });
      expect('skip' in result && result.skip).to.equal(
        SkipReason.DefaultHookNotFallbackRouting,
      );
    });

    it('skips when no supported domain routes to an aggregation hook', async () => {
      const spec = baseSpec();
      spec.routes = { 2: NON_AGG, 3: NON_AGG };
      const result = await readChainState({
        chain: 'origin',
        originDomainId: ORIGIN_DOMAIN,
        mailbox: MAILBOX,
        factory: FACTORY,
        supportedDomains: SUPPORTED,
        registryDomainIds: REGISTRY_DOMAIN_IDS,
        reader: fakeReader(spec),
        concurrency: 4,
      });
      expect('skip' in result && result.skip).to.equal(
        SkipReason.NoAggregationRoutes,
      );
    });

    it('rejects when the registry aggregationHook is not an aggregation hook', async () => {
      let error: unknown;
      try {
        await stateFor(baseSpec(), NON_AGG);
      } catch (e: unknown) {
        error = e;
      }
      expect(error instanceof Error ? error.message : '').to.include(
        'is not an aggregation hook',
      );
    });

    it('propagates transport errors instead of classifying the hook as unknown', async () => {
      const spec = baseSpec();
      spec.failHookType = AGG_LEGACY;
      let error: unknown;
      try {
        await stateFor(spec);
      } catch (e: unknown) {
        error = e;
      }
      expect(error).to.be.instanceOf(Error);
      expect(error instanceof Error ? error.message : '').to.equal(
        'rate limited',
      );
      expect(
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined,
      ).to.equal('SERVER_ERROR');
    });
  });

  describe('planChain', () => {
    it('gates per aggregator, not per factory', async () => {
      const spec = baseSpec();
      spec.versions[key(FACTORY)] = '12.2.0';
      const plan = planChain(await stateFor(spec), UpgradePhase.Prod);
      expect(plan.needsFactory).to.equal(false);
      expect(plan.migrations).to.have.length(3);
      expect(plan.upToDate).to.equal(false);
    });

    it('requires a new factory even when every aggregator is fixed', async () => {
      const spec = baseSpec();
      spec.routes = { 2: AGG_FIXED, 3: AGG_FIXED, 4: AGG_FIXED };
      const state = await stateFor(spec);
      for (const phase of Object.values(UpgradePhase)) {
        const plan = planChain(state, phase);
        expect(plan.needsFactory).to.equal(true);
        expect(plan.upToDate).to.equal(false);
      }
    });

    it('keeps differently ordered child lists as separate sets and dedupes equal ones', async () => {
      const spec = baseSpec();
      spec.routes = {
        2: AGG_LEGACY,
        3: AGG_LEGACY,
        4: AGG_LEGACY_REORDERED,
      };
      const plan = planChain(await stateFor(spec), UpgradePhase.Prod);
      expect(plan.sets.map((set) => set.key)).to.deep.equal([
        aggregatorKey([PAUSABLE, MERKLE, IGP]),
        aggregatorKey([MERKLE, PAUSABLE, IGP]),
      ]);
      expect(plan.sets[0].replaces).to.deep.equal([AGG_LEGACY]);
      expect(plan.migrations.map((m) => m.key)).to.deep.equal([
        plan.sets[0].key,
        plan.sets[0].key,
        plan.sets[1].key,
      ]);
    });

    it('maps a legacy registry aggregationHook onto the matching routed set', async () => {
      const state = await stateFor(baseSpec(), AGG_LEGACY);
      const plan = planChain(state, UpgradePhase.Prod);
      expect(plan.sets).to.have.length(1);
      expect(plan.registryAggregationKey).to.equal(plan.sets[0].key);
      expect(plan.sets[0].replaces).to.deep.equal([AGG_LEGACY]);
    });

    it('only requires the registry update in the prod phase', async () => {
      const spec = baseSpec();
      spec.versions[key(FACTORY)] = '12.2.0';
      spec.routes = { 2: AGG_FIXED, 3: AGG_FIXED, 4: AGG_FIXED };
      const state = await stateFor(spec, AGG_LEGACY_REORDERED);
      const shadow = planChain(state, UpgradePhase.Shadow);
      expect(shadow.upToDate).to.equal(true);
      expect(shadow.sets).to.have.length(0);
      const prod = planChain(state, UpgradePhase.Prod);
      expect(prod.upToDate).to.equal(false);
      expect(prod.migrations).to.have.length(0);
      expect(prod.sets).to.have.length(1);
    });

    it('does not touch a fixed registry aggregationHook', async () => {
      const spec = baseSpec();
      const plan = planChain(
        await stateFor(spec, AGG_FIXED),
        UpgradePhase.Prod,
      );
      expect(plan.registryAggregationKey).to.equal(undefined);
    });
  });

  describe('route targets', () => {
    const NEW_AGG = addr(0x500);

    it('prod targets only the legacy-mapped supported domains', async () => {
      const spec = baseSpec();
      spec.routes = { 2: AGG_LEGACY, 3: AGG_FIXED, 4: NON_AGG };
      const state = await stateFor(spec);
      const plan = planChain(state, UpgradePhase.Prod);
      const targets = buildProdTargets(
        plan,
        new Map([[plan.sets[0].key, NEW_AGG]]),
      );
      expect(targets).to.deep.equal([{ destination: 2, hook: NEW_AGG }]);
    });

    it('shadow targets mirror every mapped supported domain', async () => {
      const spec = baseSpec();
      spec.routes = { 2: AGG_LEGACY, 3: AGG_FIXED, 4: NON_AGG };
      const state = await stateFor(spec);
      const plan = planChain(state, UpgradePhase.Shadow);
      const targets = buildShadowTargets(
        state,
        plan,
        new Map([[plan.sets[0].key, NEW_AGG]]),
      );
      expect(targets).to.deep.equal([
        { destination: 2, hook: NEW_AGG },
        { destination: 3, hook: AGG_FIXED },
        { destination: 4, hook: NON_AGG },
      ]);
    });

    it('shadow targets clear the unmapped supported domains', async () => {
      const spec = baseSpec();
      spec.routes = { 2: AGG_LEGACY, 3: AGG_FIXED };
      const state = await stateFor(spec);
      const plan = planChain(state, UpgradePhase.Shadow);
      const targets = buildShadowTargets(
        state,
        plan,
        new Map([[plan.sets[0].key, NEW_AGG]]),
      );
      expect(targets).to.deep.equal([
        { destination: 2, hook: NEW_AGG },
        { destination: 3, hook: AGG_FIXED },
        { destination: 4, hook: constants.AddressZero },
      ]);
    });

    it('rejects when a needed aggregator address is missing', async () => {
      const state = await stateFor(baseSpec());
      const plan = planChain(state, UpgradePhase.Prod);
      expect(() => buildProdTargets(plan, new Map())).to.throw(
        'Missing new aggregator',
      );
    });
  });

  describe('chunkRoutes and diffRoutes', () => {
    const routes = Array.from({ length: 130 }, (_, i) => ({
      destination: i + 1,
      hook: addr(0x600),
    }));

    it('splits into the default batch size', () => {
      expect(
        chunkRoutes('ethereum', routes).map((b) => b.length),
      ).to.deep.equal([64, 64, 2]);
    });

    it('uses the chain specific batch size', () => {
      const sizes = chunkRoutes('citrea', routes).map((b) => b.length);
      expect(sizes).to.have.length(9);
      expect(sizes.slice(0, 8)).to.deep.equal(Array(8).fill(16));
      expect(sizes[8]).to.equal(2);
    });

    it('only returns routes that differ from the current state', () => {
      const current = new Map<number, Address>([
        [1, addr(0x600)],
        [2, addr(0x601)],
      ]);
      const targets = [
        { destination: 1, hook: addr(0x600).toLowerCase() },
        { destination: 2, hook: addr(0x600) },
        { destination: 3, hook: addr(0x600) },
      ];
      expect(
        diffRoutes(current, targets).map((r) => r.destination),
      ).to.deep.equal([2, 3]);
    });
  });

  describe('assertChildrenPreserved', () => {
    it('accepts the same ordered children regardless of address casing', () => {
      expect(() =>
        assertChildrenPreserved(
          [PAUSABLE, MERKLE, IGP],
          [PAUSABLE.toLowerCase(), MERKLE, IGP],
          'agg',
        ),
      ).to.not.throw();
    });

    it('rejects the same set in a different order', () => {
      expect(() =>
        assertChildrenPreserved(
          [PAUSABLE, MERKLE, IGP],
          [MERKLE, PAUSABLE, IGP],
          'agg',
        ),
      ).to.throw('order-sensitive');
    });

    it('rejects a different number of children', () => {
      expect(() =>
        assertChildrenPreserved([PAUSABLE, MERKLE], [PAUSABLE], 'agg'),
      ).to.throw('order-sensitive');
    });
  });

  describe('registry updates', () => {
    const current: ChainAddresses = {
      aggregationHook: addr(0x700),
      fallbackRoutingHook: ROUTING,
      mailbox: MAILBOX,
      merkleTreeHook: MERKLE,
      staticAggregationHookFactory: FACTORY,
    };

    it('changes only the factory and aggregationHook keys of the full map', () => {
      const newFactory = addr(0x701);
      const newAggregation = addr(0x702);
      const updated = buildRegistryAddresses(current, {
        staticAggregationHookFactory: newFactory,
        aggregationHook: newAggregation,
      });
      expect(updated).to.deep.equal({
        aggregationHook: newAggregation,
        fallbackRoutingHook: ROUTING,
        mailbox: MAILBOX,
        merkleTreeHook: MERKLE,
        staticAggregationHookFactory: newFactory,
      });
      expect(current.aggregationHook).to.equal(addr(0x700));
    });

    it('leaves absent keys untouched when only the factory is updated', () => {
      const updated = buildRegistryAddresses(current, {
        staticAggregationHookFactory: addr(0x701),
      });
      expect(updated.aggregationHook).to.equal(current.aggregationHook);
      expect(Object.keys(updated).sort()).to.deep.equal(
        Object.keys(current).sort(),
      );
    });

    it('never writes the shadow routing hook to the registry but records it in the export', async () => {
      const shadow = addr(0x800);
      const updated = buildRegistryAddresses(current, {
        staticAggregationHookFactory: addr(0x701),
        aggregationHook: addr(0x702),
      });
      expect(Object.values(updated)).to.not.include(shadow);
      expect(updated.fallbackRoutingHook).to.equal(ROUTING);

      const store = createMemoryExportStore();
      await store.update(
        'origin',
        exportUpdate({ shadowRoutingHook: shadow }),
        '2026-10-06T00:00:00.000Z',
      );
      expect((await store.read('origin'))?.shadowRoutingHook).to.equal(shadow);
    });
  });

  function exportUpdate(
    overrides: Partial<ChainExportUpdate> = {},
  ): ChainExportUpdate {
    return {
      signer: addr(0x900),
      phase: UpgradePhase.Shadow,
      routingHook: ROUTING,
      routingHookOwner: OWNER,
      routingHookOwnerType: Owner.DEPLOYER,
      factory: { address: addr(0x701), version: '12.2.0' },
      aggregators: [
        {
          children: [PAUSABLE, MERKLE, IGP],
          address: addr(0x702),
          replaces: [AGG_LEGACY],
        },
      ],
      ...overrides,
    };
  }

  describe('address export', () => {
    const T0 = '2026-10-06T00:00:00.000Z';
    const T1 = '2026-10-07T00:00:00.000Z';

    it('records a first entry and treats an identical re-run as a no-op', () => {
      const first = mergeChainExport(undefined, exportUpdate(), T0);
      expect(first.changed).to.equal(true);
      expect(first.entry.firstRecordedAt).to.equal(T0);
      expect(first.entry.updatedAt).to.equal(T0);

      const second = mergeChainExport(first.entry, exportUpdate(), T1);
      expect(second.changed).to.equal(false);
      expect(second.entry).to.deep.equal(first.entry);
    });

    it('unions aggregators by address without duplicates', () => {
      const first = mergeChainExport(undefined, exportUpdate(), T0).entry;
      const update = exportUpdate({
        aggregators: [
          {
            children: [PAUSABLE, MERKLE, IGP],
            address: addr(0x702).toLowerCase(),
            replaces: [AGG_LEGACY, AGG_LEGACY_B],
          },
          {
            children: [MERKLE, PAUSABLE, IGP],
            address: addr(0x703),
            replaces: [],
          },
        ],
      });
      const merged = mergeChainExport(first, update, T1);
      expect(merged.changed).to.equal(true);
      expect(
        merged.entry.aggregators.map((a) => a.address.toLowerCase()),
      ).to.deep.equal([addr(0x702).toLowerCase(), addr(0x703).toLowerCase()]);
      expect(merged.entry.aggregators[0].replaces).to.deep.equal([
        AGG_LEGACY,
        AGG_LEGACY_B,
      ]);
      expect(merged.entry.firstRecordedAt).to.equal(T0);
      expect(merged.entry.updatedAt).to.equal(T1);
    });

    it('keeps the replaced factory and the shadow hook across later runs', () => {
      const shadow = addr(0x800);
      const first = mergeChainExport(
        undefined,
        exportUpdate({
          shadowRoutingHook: shadow,
          factory: {
            address: addr(0x701),
            version: '12.2.0',
            previous: { address: FACTORY, version: '9.0.10' },
          },
        }),
        T0,
      ).entry;
      const prodRun = mergeChainExport(
        first,
        exportUpdate({ phase: UpgradePhase.Prod }),
        T1,
      );
      expect(prodRun.entry.shadowRoutingHook).to.equal(shadow);
      expect(prodRun.entry.factory.previous).to.deep.equal({
        address: FACTORY,
        version: '9.0.10',
      });
      expect(prodRun.entry.phase).to.equal(UpgradePhase.Prod);
    });

    it('records the previous factory when the factory address changes', () => {
      const first = mergeChainExport(undefined, exportUpdate(), T0).entry;
      const rotated = mergeChainExport(
        first,
        exportUpdate({ factory: { address: addr(0x7ff), version: '12.2.0' } }),
        T1,
      );
      expect(rotated.entry.factory.previous).to.deep.equal({
        address: addr(0x701),
        version: '12.2.0',
      });
    });

    it('persists concurrent per-chain updates to the export file', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'aggregation-export-'));
      try {
        const file = join(dir, 'addresses.json');
        const store = createFileExportStore(file);
        await Promise.all([
          store.update('chainb', exportUpdate(), T0),
          store.update(
            'chaina',
            exportUpdate({ shadowRoutingHook: addr(0x800) }),
            T0,
          ),
        ]);
        const written: Record<string, ChainExport> = JSON.parse(
          readFileSync(file, 'utf8'),
        );
        expect(Object.keys(written)).to.deep.equal(['chaina', 'chainb']);
        expect(written.chaina.shadowRoutingHook).to.equal(addr(0x800));
        expect(written.chainb.shadowRoutingHook).to.equal(undefined);

        await store.update(
          'chaina',
          exportUpdate({ shadowRoutingHook: addr(0x800) }),
          T1,
        );
        const reread: Record<string, ChainExport> = JSON.parse(
          readFileSync(file, 'utf8'),
        );
        expect(reread.chaina.updatedAt).to.equal(T0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('summary', () => {
    const base = (
      chain: string,
      outcome: ChainResult['outcome'],
    ): ChainResult => ({
      chain,
      outcome,
      aggregators: [],
      verificationRecoveryFiles: [],
      registryKeysWritten: [],
      pending: [],
    });

    it('fails when a chain errored', () => {
      expect(
        computeExitCode([base('a', ChainOutcome.Error)], undefined),
      ).to.equal(1);
    });

    it('does not fail on skipped chains when chains were not explicitly requested', () => {
      expect(
        computeExitCode([base('a', ChainOutcome.Skipped)], undefined),
      ).to.equal(0);
    });

    it('fails when an explicitly requested chain was skipped', () => {
      expect(
        computeExitCode(
          [base('a', ChainOutcome.Skipped), base('b', ChainOutcome.Applied)],
          ['a'],
        ),
      ).to.equal(1);
      expect(
        computeExitCode(
          [base('a', ChainOutcome.Skipped), base('b', ChainOutcome.Applied)],
          ['b'],
        ),
      ).to.equal(0);
    });

    it('prints a warp deploy snippet per shadow routing hook', () => {
      const withShadow: ChainResult = {
        chain: 'ethereum',
        outcome: ChainOutcome.Applied,
        aggregators: [],
        verificationRecoveryFiles: [],
        registryKeysWritten: [],
        pending: [],
        shadowRoutingHook: addr(0x800),
      };
      expect(
        shadowSnippets([withShadow, base('base', ChainOutcome.UpToDate)]),
      ).to.deep.equal([`# ethereum: warp deploy.yaml\nhook: "${addr(0x800)}"`]);
    });

    it('labels shadow snippets from a fork run', () => {
      const withShadow: ChainResult = {
        chain: 'ethereum',
        outcome: ChainOutcome.Applied,
        aggregators: [],
        verificationRecoveryFiles: [],
        registryKeysWritten: [],
        pending: [],
        shadowRoutingHook: addr(0x800),
      };
      expect(shadowSnippets([withShadow], { fork: true })).to.deep.equal([
        `# ${FORK_LABEL}\n# ethereum: warp deploy.yaml\nhook: "${addr(0x800)}"`,
      ]);
    });
  });
  describe('createUpgradeMultiProvider', () => {
    const CHAINS = ['test1', 'test2'];

    interface Calls {
      getMultiProvider: Array<
        [
          Contexts | undefined,
          Role | undefined,
          boolean | undefined,
          string[] | undefined,
        ]
      >;
      getRegistry: Array<[boolean | undefined, string[] | undefined]>;
    }

    function fakeEnvConfig(calls: Calls) {
      return {
        getMultiProvider: async (
          context?: Contexts,
          role?: Role,
          useSecrets?: boolean,
          chains?: string[],
        ) => {
          calls.getMultiProvider.push([context, role, useSecrets, chains]);
          return MultiProvider.createTestMultiProvider();
        },
        getRegistry: async (useSecrets?: boolean, chains?: string[]) => {
          calls.getRegistry.push([useSecrets, chains]);
          return new PartialRegistry({ chainMetadata: testChainMetadata });
        },
      };
    }

    it('never requests the deployer role for planning and fork runs', async () => {
      const calls: Calls = { getMultiProvider: [], getRegistry: [] };
      const multiProvider = await createUpgradeMultiProvider({
        envConfig: fakeEnvConfig(calls),
        context: Contexts.Hyperlane,
        chains: CHAINS,
        signed: false,
      });
      expect(calls.getMultiProvider).to.deep.equal([]);
      expect(calls.getRegistry).to.deep.equal([[true, CHAINS]]);
      expect(multiProvider.tryGetSigner('test1')).to.equal(null);
      expect(multiProvider.tryGetChainMetadata('test1')).to.not.equal(null);
    });

    it('requests the deployer role when sending transactions', async () => {
      const calls: Calls = { getMultiProvider: [], getRegistry: [] };
      await createUpgradeMultiProvider({
        envConfig: fakeEnvConfig(calls),
        context: Contexts.Hyperlane,
        chains: CHAINS,
        signed: true,
      });
      expect(calls.getMultiProvider).to.deep.equal([
        [Contexts.Hyperlane, Role.Deployer, true, CHAINS],
      ]);
      expect(calls.getRegistry).to.deep.equal([]);
    });
  });

  describe('verification inputs file', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'verification-inputs-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const input = (n: number, name: string): ContractVerificationInput => ({
      name,
      address: addr(n),
      constructorArguments: '',
      isProxy: false,
    });

    function readInputs(file: string) {
      return JSON.parse(readFileSync(file, 'utf8'));
    }

    it('creates the file and its directory on the first write', async () => {
      const file = join(dir, 'new-module', 'verification.json');
      await writeVerificationInputsToFile(file, {
        origin: [input(0x700, 'First')],
      });
      expect(readInputs(file)).to.deep.equal({
        origin: [input(0x700, 'First')],
      });
    });

    it('merges into an existing file without duplicating inputs', async () => {
      const file = join(dir, 'verification.json');
      await writeVerificationInputsToFile(file, {
        origin: [input(0x700, 'First')],
      });
      await writeVerificationInputsToFile(file, {
        origin: [input(0x700, 'First'), input(0x701, 'Second')],
        other: [input(0x702, 'Third')],
      });
      expect(readInputs(file)).to.deep.equal({
        origin: [input(0x700, 'First'), input(0x701, 'Second')],
        other: [input(0x702, 'Third')],
      });
    });
  });

  describe('secret redaction', () => {
    const SECRET_HOST = 'secret-host.invalid';
    const SECRET_PATH = 'apikey-SECRET123';
    const ethersMessage =
      'missing response (requestBody="{\\"method\\":\\"eth_call\\"}", requestMethod="POST", ' +
      `serverError={"errno":-3008,"code":"ENOTFOUND","syscall":"getaddrinfo","hostname":"${SECRET_HOST}"}, ` +
      `url="https://${SECRET_HOST}/${SECRET_PATH}", code=SERVER_ERROR, version=web/5.8.0)`;

    interface Case {
      name: string;
      input: string;
      expected: string;
    }
    const cases: Case[] = [
      {
        name: 'redacts the url and hostname of an ethers server error',
        input: ethersMessage,
        expected:
          'missing response (requestBody="{\\"method\\":\\"eth_call\\"}", requestMethod="POST", ' +
          `serverError={"errno":-3008,"code":"ENOTFOUND","syscall":"getaddrinfo","hostname":"${REDACTED_HOST}"}, ` +
          `url="${REDACTED_URL}", code=SERVER_ERROR, version=web/5.8.0)`,
      },
      {
        name: 'redacts websocket and credentialed urls',
        input: `connect failed wss://user:pw@${SECRET_HOST}:8546/${SECRET_PATH}?key=1 and http://${SECRET_HOST}`,
        expected: `connect failed ${REDACTED_URL} and ${REDACTED_URL}`,
      },
      {
        name: 'redacts assigned hostnames',
        input: `getaddrinfo ENOTFOUND hostname=${SECRET_HOST}, code=X`,
        expected: `getaddrinfo ENOTFOUND hostname=${REDACTED_HOST}, code=X`,
      },
      {
        name: 'keeps messages without secrets unchanged',
        input: `call revert exception (method="defaultHook()", data="0x", code=CALL_EXCEPTION)`,
        expected: `call revert exception (method="defaultHook()", data="0x", code=CALL_EXCEPTION)`,
      },
    ];
    for (const c of cases) {
      it(c.name, () => {
        expect(redactSecrets(c.input)).to.equal(c.expected);
      });
    }

    it('describes non-Error rejections without leaking', () => {
      expect(
        describeError({ message: `bad https://${SECRET_HOST}/k` }),
      ).to.equal(`bad ${REDACTED_URL}`);
      expect(describeError(`plain https://${SECRET_HOST}/k`)).to.equal(
        `plain ${REDACTED_URL}`,
      );
    });

    it('keeps provider urls out of per-chain results and logs', async () => {
      const multiProvider = MultiProvider.createTestMultiProvider();
      const provider = new providers.JsonRpcProvider('http://127.0.0.1:1', {
        chainId: 31337,
        name: 'test',
      });
      sinon.stub(provider, 'call').rejects(new Error(ethersMessage));
      multiProvider.setProvider('test1', provider);

      const lines: string[] = [];
      const logger = pino(
        { level: 'debug' },
        {
          write: (line: string) => {
            lines.push(line);
          },
        },
      );
      const [result] = await runUpgrade(
        {
          environment: 'test',
          phase: UpgradePhase.Shadow,
          apply: false,
          multiProvider,
          chainAddresses: {
            test1: { mailbox: MAILBOX, staticAggregationHookFactory: FACTORY },
          },
          supportedDomains: SUPPORTED,
          registryDomainIds: REGISTRY_DOMAIN_IDS,
          skipLists: { legacyCoreHookRecoveryChains: [], chainsToSkip: [] },
          persist: {
            writeRegistryAddresses: () => {},
            writeVerificationInputs: async () => {},
            writeVerificationRecovery: async () => '',
            writeTransactions: async () => '',
            exportStore: createMemoryExportStore(),
          },
          concurrency: 1,
          probeConcurrency: 1,
          logger,
          now: () => '2026-10-06T00:00:00.000Z',
        },
        ['test1'],
      );

      expect(result.outcome).to.equal(ChainOutcome.Error);
      expect(result.detail).to.include(REDACTED_URL);
      expect(result.detail).to.include('code=SERVER_ERROR');
      for (const text of [result.detail ?? '', ...lines]) {
        expect(text).to.not.include(SECRET_HOST);
        expect(text).to.not.include(SECRET_PATH);
      }
      expect(lines.length).to.be.greaterThan(0);
    });
  });
});
