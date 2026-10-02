import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { utils } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

import {
  type ReplayFixture,
  type ReplayServer,
  createReplayReader,
  loadReplayFixture,
  parseReplayFixture,
  serializeReplayFixture,
  recordedCode,
  startReplayServer,
  withCallError,
  withCallResult,
  withCodeSuffix,
  withStorage,
} from '../test/replayRpc.js';
import {
  REPLAY_SCENARIOS,
  type ReplayScenario,
  runProbe,
} from '../test/replayScenarios.js';
import {
  isMissingSelectorCallException,
  isPanicRevert,
} from '../utils/contract.js';

import type { EvmWarpRouteReader } from './EvmWarpRouteReader.js';
import {
  EIP1967_BEACON_SLOT,
  EIP1967_IMPLEMENTATION_SLOT,
} from '../deploy/proxy.js';

import { TokenType } from './config.js';

chai.use(chaiAsPromised);

const OPCODE_INVALID = 0xfe;
const OPCODE_DELEGATECALL = 0xf4;
const SCALE_SELECTOR = '0xf51e181a';
const FEE_HOOK_SELECTOR = '0xf11f4461';
const MINTING_CURRENT_LIMIT_SELECTOR = new utils.Interface([
  'function mintingCurrentLimitOf(address) view returns (uint256)',
]).getSighash('mintingCurrentLimitOf');

function hasOpcode(code: string, opcode: number): boolean {
  const hex = utils.hexlify(code).slice(2);
  for (let offset = 0; offset + 2 <= hex.length; offset += 2) {
    const current = Number.parseInt(hex.slice(offset, offset + 2), 16);
    if (current === opcode) return true;
    if (current >= 0x60 && current <= 0x7f) offset += (current - 0x5f) * 2;
  }
  return false;
}

function codeOf(fixture: ReplayFixture, address: string): string {
  const code = recordedCode(fixture, address);
  assert(code, `Fixture ${fixture.scenario} has no code for ${address}`);
  return code;
}

interface Case {
  name: string;
  scenario: string;
  // synthetic variant of the recording, see the fixtures README
  derive?: (fixture: ReplayFixture) => ReplayFixture;
  assertResult(result: unknown): void;
  // when set, the read must reject with this message instead of returning
  expectedError?: string;
  // `<to>:<calldata prefix>` eth_calls the reader must make, so the scenario
  // cannot pass because the call was skipped
  requiredCalls: string[];
  // `<to>:<calldata prefix>` eth_calls the reader must not make
  forbiddenCalls: string[];
  // asserts the data still has the property that makes the scenario a
  // regression test
  assertFixtureProperty(fixture: ReplayFixture): void;
  // asserts how the recorded node response classifies once ethers wraps it;
  // omitted for derived variants, whose responses are not all recorded
  assertProbeError?(error: unknown): void;
}

const WRAPPED_TOKEN_SELECTOR = '0x996c6cc3';
const PACKAGE_VERSION_SELECTOR = '0x93c44847';
const OWNER_SELECTOR = '0x8da5cb5b';
const MAGIC_ROUTER = '0xf1572d1da5c3cce14ee5a1c9327d17e9ff0e3f43';
const USDC_LUKSO_ROUTER = '0xe0c2e4f894d4cd33626e33b24582559f3156e1ab';
const LYX_ROUTER = '0xC210B2cB65ed3484892167F5e05F7ab496Ab0598';
const LYX_IMPLEMENTATION = '0x28a32d';
const BAT_TOKEN = '0x0D8775F648430679A709E98d2b0Cb6250d2887EF';
const MAGIC_IMPLEMENTATION = '0xb04e8cc4b9e2a8fad02a722f36923653e9a42eef';
const USDC_LUKSO_IMPLEMENTATION = '0x4ae7facd1a1e0144c68c8d42583cbe02b1942789';
const BLEND_TOKEN = '0x1385B8f55A84f2BdA13EeD4099d29Eae03d553b2';

const BLEND_ROUTER = '0x2bef59e84615371304bd731601f6344f5f304504';
const abiWord = (value: bigint | string) =>
  utils.hexZeroPad(utils.hexlify(value), 32);

function assertForwardedGetters(
  fixture: ReplayFixture,
  implementation: string,
  selector: string,
): void {
  const code = codeOf(fixture, implementation);
  expect(hasOpcode(code, OPCODE_DELEGATECALL)).to.equal(true);
  expect(code).to.not.include(selector.slice(2));
}

const unresolvedMagic = (fixture: ReplayFixture): ReplayFixture =>
  withStorage(
    withStorage(
      fixture,
      MAGIC_ROUTER,
      EIP1967_IMPLEMENTATION_SLOT,
      abiWord(0n),
    ),
    MAGIC_ROUTER,
    EIP1967_BEACON_SLOT,
    abiWord(MAGIC_IMPLEMENTATION),
  );

function assertMagicUnresolved(fixture: ReplayFixture): void {
  const beacon = fixture.requests.find(
    (r) =>
      r.method === 'eth_getStorageAt' &&
      r.address === MAGIC_ROUTER &&
      BigInt(r.slot ?? '0x0') === BigInt(EIP1967_BEACON_SLOT),
  );
  expect(BigInt(beacon?.result ?? '0x0')).to.not.equal(0n);
}

const USDC_FEE_HOOK = '0x1111111111111111111111111111111111111111';
const FORWARDED_SCALE = 10n ** 12n;

const cases: Case[] = [
  {
    // Legacy collateral token that answers every unknown selector with
    // JSON-RPC -32003 "EVM error: InvalidFEOpcode".
    name: 'bat-aleo-ethereum-collateral',
    scenario: 'bat-aleo-ethereum-collateral',
    assertResult: (result) => expect(result).to.equal(TokenType.collateral),
    requiredCalls: [
      `0x516e156e987175d74614cc2bc960f148a610f0b3:${WRAPPED_TOKEN_SELECTOR}`,
    ],
    forbiddenCalls: [
      `${BAT_TOKEN.toLowerCase()}:${MINTING_CURRENT_LIMIT_SELECTOR}`,
    ],
    assertFixtureProperty: (fixture) => {
      const code = codeOf(fixture, BAT_TOKEN);
      expect(hasOpcode(code, OPCODE_INVALID)).to.equal(true);
      expect(hasOpcode(code, OPCODE_DELEGATECALL)).to.equal(false);
      expect(code).to.not.include(MINTING_CURRENT_LIMIT_SELECTOR.slice(2));
    },
    assertProbeError: (error) => {
      expect(isMissingSelectorCallException(error)).to.equal(false);
      expect(isPanicRevert(error)).to.equal(false);
    },
  },
  {
    // EIP-1967 proxy whose implementation contains DELEGATECALL bytes but no
    // scale() getter, so the reader cannot rule the getter out and makes the
    // call; the node reverts it with code 3 and no data.
    name: 'magic-abstract-base-router',
    scenario: 'magic-abstract-base-router',
    assertResult: (result) => expect(result).to.equal(undefined),
    requiredCalls: [
      `${MAGIC_ROUTER}:${PACKAGE_VERSION_SELECTOR}`,
      `${MAGIC_ROUTER}:${SCALE_SELECTOR}`,
    ],
    forbiddenCalls: [],
    assertFixtureProperty: (fixture) =>
      assertForwardedGetters(fixture, MAGIC_IMPLEMENTATION, SCALE_SELECTOR),
    assertProbeError: (error) =>
      expect(isMissingSelectorCallException(error)).to.equal(true),
  },
  {
    // Derived: scale() answers a successful eth_call with empty data, which the
    // provider stack reports as "Invalid response from provider". The bytecode
    // does not prove the getter exists, so the reader treats it as missing.
    name: 'magic-abstract-base-router (derived: scale() answers empty data)',
    scenario: 'magic-abstract-base-router',
    derive: (fixture) =>
      withCallResult(fixture, MAGIC_ROUTER, SCALE_SELECTOR, '0x'),
    assertResult: (result) => expect(result).to.equal(undefined),
    requiredCalls: [`${MAGIC_ROUTER}:${SCALE_SELECTOR}`],
    forbiddenCalls: [],
    assertFixtureProperty: (fixture) =>
      assertForwardedGetters(fixture, MAGIC_IMPLEMENTATION, SCALE_SELECTOR),
  },
  {
    // Derived: same empty answer, but a PUSH4 of the scale() selector is
    // appended to the implementation, so the getter is proven to exist and the
    // empty answer must surface instead of reading as identity.
    name: 'magic-abstract-base-router (derived: empty data from a proven scale())',
    scenario: 'magic-abstract-base-router',
    derive: (fixture) =>
      withCallResult(
        withCodeSuffix(
          fixture,
          MAGIC_IMPLEMENTATION,
          `63${SCALE_SELECTOR.slice(2)}`,
        ),
        MAGIC_ROUTER,
        SCALE_SELECTOR,
        '0x',
      ),
    assertResult: () => undefined,
    expectedError: 'All providers failed',
    requiredCalls: [`${MAGIC_ROUTER}:${SCALE_SELECTOR}`],
    forbiddenCalls: [],
    assertFixtureProperty: (fixture) =>
      expect(codeOf(fixture, MAGIC_IMPLEMENTATION)).to.include(
        SCALE_SELECTOR.slice(2),
      ),
  },
  {
    // Derived: the implementation slot is cleared and the beacon slot set, so
    // the implementation cannot be resolved; an empty answer from scale() may
    // hide a real scale and must surface.
    name: 'magic-abstract-base-router (derived: unresolved beacon proxy, empty data)',
    scenario: 'magic-abstract-base-router',
    derive: (fixture) =>
      withCallResult(
        unresolvedMagic(fixture),
        MAGIC_ROUTER,
        SCALE_SELECTOR,
        '0x',
      ),
    assertResult: () => undefined,
    expectedError: 'All providers failed',
    requiredCalls: [`${MAGIC_ROUTER}:${SCALE_SELECTOR}`],
    forbiddenCalls: [],
    assertFixtureProperty: assertMagicUnresolved,
  },
  {
    // Derived: same unresolved proxy with the recorded code 3 revert, which is
    // tolerated.
    name: 'magic-abstract-base-router (derived: unresolved beacon proxy, recorded revert)',
    scenario: 'magic-abstract-base-router',
    derive: unresolvedMagic,
    assertResult: (result) => expect(result).to.equal(undefined),
    requiredCalls: [`${MAGIC_ROUTER}:${SCALE_SELECTOR}`],
    forbiddenCalls: [],
    assertFixtureProperty: assertMagicUnresolved,
  },
  {
    // EIP-1967 proxy whose implementation contains DELEGATECALL bytes but no
    // feeHook() getter; the node reverts feeHook() with LSP17
    // NoExtensionFoundForFunctionSelector(bytes4). scale() answers 1.
    name: 'usdc-lukso-router',
    scenario: 'usdc-lukso-router',
    assertResult: (result) =>
      expect(result).to.deep.equal({ feeHook: undefined, scale: undefined }),
    requiredCalls: [
      `${USDC_LUKSO_ROUTER}:${FEE_HOOK_SELECTOR}`,
      `${USDC_LUKSO_ROUTER}:${SCALE_SELECTOR}`,
    ],
    forbiddenCalls: [],
    assertFixtureProperty: (fixture) =>
      assertForwardedGetters(
        fixture,
        USDC_LUKSO_IMPLEMENTATION,
        FEE_HOOK_SELECTOR,
      ),
    assertProbeError: (error) =>
      expect(isMissingSelectorCallException(error)).to.equal(true),
  },
  {
    // Derived: feeHook() reverts with LSP17 NoExtensionFound for ANOTHER
    // selector, i.e. the getter exists but reaches a missing extension of
    // another contract. It must not read as an absent feeHook().
    name: 'usdc-lukso-router (derived: LSP17 revert for another selector)',
    scenario: 'usdc-lukso-router',
    derive: (fixture) =>
      withCallError(fixture, USDC_LUKSO_ROUTER, FEE_HOOK_SELECTOR, {
        code: 3,
        message: 'execution reverted',
        data: `0xbb370b2b46904840${'00'.repeat(28)}`,
      }),
    assertResult: () => undefined,
    expectedError: 'call revert exception',
    requiredCalls: [`${USDC_LUKSO_ROUTER}:${FEE_HOOK_SELECTOR}`],
    forbiddenCalls: [],
    assertFixtureProperty: (fixture) =>
      assertForwardedGetters(
        fixture,
        USDC_LUKSO_IMPLEMENTATION,
        FEE_HOOK_SELECTOR,
      ),
  },
  {
    // Derived: same bytecode and storage, but the forwarded feeHook() answers
    // with an address. A reader that skips forwarded getters returns undefined.
    name: 'usdc-lukso-router (derived: forwarded feeHook() succeeds)',
    scenario: 'usdc-lukso-router',
    derive: (fixture) =>
      withCallResult(
        fixture,
        USDC_LUKSO_ROUTER,
        FEE_HOOK_SELECTOR,
        abiWord(USDC_FEE_HOOK),
      ),
    assertResult: (result) =>
      expect(result).to.deep.equal({
        feeHook: utils.getAddress(USDC_FEE_HOOK),
        scale: undefined,
      }),
    requiredCalls: [`${USDC_LUKSO_ROUTER}:${FEE_HOOK_SELECTOR}`],
    forbiddenCalls: [],
    assertFixtureProperty: (fixture) =>
      assertForwardedGetters(
        fixture,
        USDC_LUKSO_IMPLEMENTATION,
        FEE_HOOK_SELECTOR,
      ),
  },
  {
    // Derived: the forwarded scale() answers 10^12.
    name: 'usdc-lukso-router (derived: forwarded scale() succeeds)',
    scenario: 'usdc-lukso-router',
    derive: (fixture) =>
      withCallResult(
        fixture,
        USDC_LUKSO_ROUTER,
        SCALE_SELECTOR,
        abiWord(FORWARDED_SCALE),
      ),
    assertResult: (result) =>
      expect(result).to.deep.equal({
        feeHook: undefined,
        scale: { numerator: FORWARDED_SCALE, denominator: 1n },
      }),
    requiredCalls: [`${USDC_LUKSO_ROUTER}:${SCALE_SELECTOR}`],
    forbiddenCalls: [],
    assertFixtureProperty: (fixture) => {
      const code = codeOf(fixture, USDC_LUKSO_IMPLEMENTATION);
      expect(hasOpcode(code, OPCODE_DELEGATECALL)).to.equal(true);
      const request = fixture.requests.find(
        (r) => r.to === USDC_LUKSO_ROUTER && r.data === SCALE_SELECTOR,
      );
      expect(request?.result).to.equal(abiWord(FORWARDED_SCALE));
    },
  },
  {
    // Native router (8.1.2) whose implementation has neither feeHook() nor
    // feeRecipient() and no DELEGATECALL, so the reader answers from bytecode
    // and must not make the feeHook() call; the lukso nodes revert both reads
    // with code 3 and data "0x".
    name: 'lyx-lukso-native-router',
    scenario: 'lyx-lukso-native-router',
    assertResult: (result) => {
      assert(
        typeof result === 'object' && result !== null,
        'Expected a derived config',
      );
      expect(Reflect.get(result, 'type')).to.equal(TokenType.native);
      expect(Reflect.get(result, 'contractVersion')).to.equal('8.1.2');
      expect(Reflect.get(result, 'feeHook')).to.equal(undefined);
      expect(Reflect.get(result, 'tokenFee')).to.equal(undefined);
    },
    requiredCalls: [`${LYX_ROUTER.toLowerCase()}:${OWNER_SELECTOR}`],
    forbiddenCalls: [`${LYX_ROUTER.toLowerCase()}:${FEE_HOOK_SELECTOR}`],
    assertFixtureProperty: (fixture) => {
      for (const selector of [FEE_HOOK_SELECTOR, '0x46904840']) {
        const request = fixture.requests.find((r) => r.data === selector);
        expect(request?.error?.code).to.equal(3);
        expect(request?.error?.data).to.equal('0x');
      }
      const implementation = fixture.requests.find(
        (r) =>
          r.method === 'eth_getCode' &&
          r.address?.startsWith(LYX_IMPLEMENTATION),
      );
      assert(implementation, 'Fixture has the LYX implementation code');
      const code = recordedCode(fixture, implementation.address ?? '');
      assert(code, 'Fixture has the LYX implementation code');
      expect(hasOpcode(code, OPCODE_DELEGATECALL)).to.equal(false);
      expect(code).to.not.include(FEE_HOOK_SELECTOR.slice(2));
    },
    assertProbeError: (error) =>
      expect(isMissingSelectorCallException(error)).to.equal(true),
  },
  {
    // The fluent token is an opaque delegation stub that answers any unknown
    // selector with Panic(uint256). Whether the reader makes the xERC20 probe
    // is not pinned; the read must give collateral either way.
    name: 'blend-fluent-collateral',
    scenario: 'blend-fluent-collateral',
    assertResult: (result) => expect(result).to.equal(TokenType.collateral),
    requiredCalls: [`${BLEND_ROUTER}:${WRAPPED_TOKEN_SELECTOR}`],
    forbiddenCalls: [],
    assertFixtureProperty: (fixture) => {
      const request = fixture.requests.find(
        (r) =>
          r.to === BLEND_TOKEN.toLowerCase() &&
          r.data?.startsWith(MINTING_CURRENT_LIMIT_SELECTOR),
      );
      expect(request?.error?.data).to.match(/^0x4e487b71/);
    },
    assertProbeError: (error) => expect(isPanicRevert(error)).to.equal(true),
  },
  {
    // Derived: a PUSH4 of the mintingCurrentLimitOf selector is appended to the
    // token code so the reader cannot rule the probe out and makes it; the
    // recorded Panic answer must be tolerated.
    name: 'blend-fluent-collateral (derived: probe forced, recorded Panic)',
    scenario: 'blend-fluent-collateral',
    derive: (fixture) =>
      withCodeSuffix(
        fixture,
        BLEND_TOKEN,
        `63${MINTING_CURRENT_LIMIT_SELECTOR.slice(2)}`,
      ),
    assertResult: (result) => expect(result).to.equal(TokenType.collateral),
    requiredCalls: [
      `${BLEND_TOKEN.toLowerCase()}:${MINTING_CURRENT_LIMIT_SELECTOR}`,
    ],
    forbiddenCalls: [],
    assertFixtureProperty: (fixture) =>
      expect(codeOf(fixture, BLEND_TOKEN)).to.include(
        MINTING_CURRENT_LIMIT_SELECTOR.slice(2),
      ),
  },
  {
    // Derived: forced probe that succeeds, which makes the token an xERC20.
    name: 'blend-fluent-collateral (derived: probe forced, succeeds)',
    scenario: 'blend-fluent-collateral',
    derive: (fixture) =>
      withCallResult(
        withCodeSuffix(
          fixture,
          BLEND_TOKEN,
          `63${MINTING_CURRENT_LIMIT_SELECTOR.slice(2)}`,
        ),
        BLEND_TOKEN,
        MINTING_CURRENT_LIMIT_SELECTOR,
        abiWord(42n),
      ),
    assertResult: (result) => expect(result).to.equal(TokenType.XERC20),
    requiredCalls: [
      `${BLEND_TOKEN.toLowerCase()}:${MINTING_CURRENT_LIMIT_SELECTOR}`,
    ],
    forbiddenCalls: [],
    assertFixtureProperty: (fixture) =>
      expect(codeOf(fixture, BLEND_TOKEN)).to.include(
        MINTING_CURRENT_LIMIT_SELECTOR.slice(2),
      ),
  },
];

describe('EvmWarpRouteReader production route replay', () => {
  for (const c of cases) {
    describe(c.name, () => {
      const scenario: ReplayScenario | undefined = REPLAY_SCENARIOS.find(
        (s) => s.scenario === c.scenario,
      );
      assert(scenario, `Unknown scenario ${c.scenario}`);
      const recorded = loadReplayFixture(c.scenario);
      const fixture = c.derive ? c.derive(recorded) : recorded;
      let server: ReplayServer;
      let reader: EvmWarpRouteReader;
      let provider: ReturnType<typeof createReplayReader>['provider'];

      before(async () => {
        server = await startReplayServer(fixture);
      });

      after(async () => {
        await server.close();
      });

      beforeEach(() => {
        server.ethCalls.length = 0;
        server.unexpected.length = 0;
        ({ reader, provider } = createReplayReader(
          server.url,
          fixture.chainId,
        ));
      });

      afterEach(() => {
        expect(server.unexpected, 'unrecorded requests').to.deep.equal([]);
      });

      it('keeps the property that makes the recording a regression test', () => {
        expect(() => c.assertFixtureProperty(fixture)).to.not.throw();
      });

      it('reads the route without throwing', async () => {
        if (c.expectedError) {
          await expect(
            scenario.run(reader, scenario.router),
          ).to.be.rejectedWith(c.expectedError);
          return;
        }
        const result = await scenario.run(reader, scenario.router);
        expect(() => c.assertResult(result)).to.not.throw();
      });

      it('makes the calls that exercise the recorded response', async () => {
        await scenario.run(reader, scenario.router).catch(() => undefined);
        for (const required of c.requiredCalls) {
          expect(
            server.ethCalls.some((call) => call.startsWith(required)),
            required,
          ).to.equal(true);
        }
      });

      for (const forbidden of c.forbiddenCalls) {
        it(`does not make the call ${forbidden}`, async () => {
          await scenario.run(reader, scenario.router);
          expect(
            server.ethCalls.filter((call) => call.startsWith(forbidden)),
          ).to.deep.equal([]);
        });
      }

      for (const probe of c.assertProbeError ? scenario.probes : []) {
        it(`classifies the recorded ${probe.signature.split(' ')[0]} response`, async () => {
          let thrown: unknown;
          try {
            await runProbe(provider, probe);
          } catch (error) {
            thrown = error;
          }
          expect(thrown, 'recorded response is an error').to.not.equal(
            undefined,
          );
          c.assertProbeError?.(thrown);
        });
      }
    });
  }
});

describe('replay fixture serialization', () => {
  const word = `0x${'ab'.repeat(32)}`;
  const base: ReplayFixture = {
    scenario: 'serialization',
    chain: 'test',
    chainId: 1,
    blockNumber: 1,
    capturedAt: '2026-01-01T00:00:00.000Z',
    requests: [{ method: 'eth_getStorageAt', address: '0x01', slot: word }],
  };

  it('splits 64-nibble words and joins them back on load', () => {
    const text = serializeReplayFixture(base);

    expect(text).to.not.match(/\b(0x)?[0-9a-fA-F]{64}\b/);
    expect(text).to.include(`${word.slice(0, 34)}_${word.slice(34)}`);
    expect(parseReplayFixture(text)).to.deep.equal(base);
  });

  const secretCases = [
    { name: 'a URL', text: 'https://rpc.example/path' },
    { name: 'an api key query', text: 'x?key=abc' },
    { name: 'an apikey field', text: 'ApiKey' },
  ];

  for (const c of secretCases) {
    it(`refuses to serialize ${c.name}`, () => {
      expect(() =>
        serializeReplayFixture({
          scenario: base.scenario,
          chain: base.chain,
          chainId: base.chainId,
          blockNumber: base.blockNumber,
          capturedAt: base.capturedAt,
          requests: [
            {
              method: 'eth_call',
              to: '0x01',
              data: '0x02',
              error: { code: -32000, message: c.text },
            },
          ],
        }),
      ).to.throw('refusing to serialize');
    });
  }
});
