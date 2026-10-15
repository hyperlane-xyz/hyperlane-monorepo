import { expect } from 'chai';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { BigNumber, Wallet, constants, utils } from 'ethers';
import sinon from 'sinon';

import {
  MultiProvider,
  OnchainHookType,
  PERMIT2_ADDRESS,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  createFileChainStore,
  createMemoryChainStore,
} from '../src/aggregation-hook-upgrade/address-export.js';
import { tokens as warpTokens } from '../src/config/warp.js';
import {
  assertDeployableChains,
  loadFeeTokens,
} from '../src/ica-quoted-calls-deploy/config.js';
import {
  IcaChainExport,
  IcaChainExportUpdate,
  mergeIcaExport,
} from '../src/ica-quoted-calls-deploy/export.js';
import {
  PendingState,
  candidateAddresses,
  readPendingState,
  validateShadowHook,
} from '../src/ica-quoted-calls-deploy/read.js';
import type { IcaChainReader } from '../src/ica-quoted-calls-deploy/reader.js';
import {
  PeerRouter,
  RouterWiringState,
  assessFunds,
  effectiveFees,
  estimateWiringSteps,
  isPairVersion,
  planWiring,
  selectQuotedCalls,
  selectRouter,
  wiringGasSteps,
} from '../src/ica-quoted-calls-deploy/plan.js';
import {
  REDACTED_KEY,
  createKeyRedactor,
  describeIcaError,
  loadWalletFromEnv,
  parseOwner,
  parsePriorityFeeGwei,
  withPriorityFee,
} from '../src/ica-quoted-calls-deploy/signer.js';
import {
  computeExitCode,
  printSummary,
} from '../src/ica-quoted-calls-deploy/summary.js';
import {
  Adoption,
  CandidateSource,
  ChainResult,
  ContractKind,
  FeeToken,
  IcaOutcome,
  PeerDomain,
  QuotedCallsCandidate,
  RouterCandidate,
  ShadowHook,
  TokenAllowance,
} from '../src/ica-quoted-calls-deploy/types.js';

const addr = (n: number): Address =>
  utils.getAddress(utils.hexZeroPad(utils.hexlify(n), 20));

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

const SIGNER = addr(0x1);
const OWNER = addr(0x2);
const STRANGER = addr(0x3);
const MAILBOX = addr(0x10);
const IGP = addr(0x11);
const SHADOW = addr(0x12);
const USDC: FeeToken = { symbol: 'USDC', address: addr(0x20) };
const USDT: FeeToken = { symbol: 'USDT', address: addr(0x21) };
const PEERS: PeerDomain[] = [
  { chain: 'base', domainId: 8453 },
  { chain: 'ink', domainId: 57073 },
];

interface RouterFields {
  address?: Address;
  source?: CandidateSource;
  version?: string;
  owner?: Address;
  mailbox?: Address;
}

function routerCandidate(fields: RouterFields = {}): RouterCandidate {
  return {
    address: fields.address ?? addr(0x100),
    source: fields.source ?? CandidateSource.Registry,
    version: fields.version ?? '12.2.0',
    owner: fields.owner ?? SIGNER,
    mailbox: fields.mailbox ?? MAILBOX,
    hook: constants.AddressZero,
  };
}

function quotedCallsCandidate(
  fields: { version?: string; permit2?: Address } = {},
): QuotedCallsCandidate {
  return {
    address: addr(0x200),
    source: CandidateSource.Registry,
    version: fields.version ?? '12.2.0',
    permit2: fields.permit2 ?? PERMIT2_ADDRESS,
  };
}

const allowance = (token: FeeToken, value: BigNumber): TokenAllowance => ({
  token,
  spender: IGP,
  allowance: value,
});

function wiringState(
  fields: {
    owner?: Address;
    hook?: Address;
    remoteRouters?: Map<number, string>;
  } = {},
): RouterWiringState {
  return {
    owner: fields.owner ?? SIGNER,
    hook: fields.hook ?? constants.AddressZero,
    remoteRouters: fields.remoteRouters ?? new Map(),
  };
}

// The test chains' providers are zkSync-aware, so blocks carry L1 batch fields.
function block(baseFeePerGas?: BigNumber) {
  return {
    hash: constants.HashZero,
    parentHash: constants.HashZero,
    number: 1,
    timestamp: 1,
    nonce: '0x0000000000000000',
    difficulty: 0,
    _difficulty: BigNumber.from(0),
    gasLimit: BigNumber.from(0),
    gasUsed: BigNumber.from(0),
    miner: constants.AddressZero,
    extraData: '0x',
    baseFeePerGas,
    transactions: [],
    l1BatchNumber: 0,
    l1BatchTimestamp: 0,
  };
}

function unexpected(method: string): never {
  throw new Error(`unexpected read: ${method}`);
}

// Reads a test does not expect throw, so a check that is skipped shows up.
function fakeReader(fields: Partial<IcaChainReader> = {}): IcaChainReader {
  return {
    hasCode: fields.hasCode ?? (async () => unexpected('hasCode')),
    minedTransactionCount:
      fields.minedTransactionCount ??
      (async () => unexpected('minedTransactionCount')),
    packageVersion:
      fields.packageVersion ?? (async () => unexpected('packageVersion')),
    routerState: fields.routerState ?? (async () => unexpected('routerState')),
    remoteRouter:
      fields.remoteRouter ?? (async () => unexpected('remoteRouter')),
    quotedCallsPermit2:
      fields.quotedCallsPermit2 ??
      (async () => unexpected('quotedCallsPermit2')),
    hookState: fields.hookState ?? (async () => unexpected('hookState')),
    allowance: fields.allowance ?? (async () => unexpected('allowance')),
    hasTokenGasOracle:
      fields.hasTokenGasOracle ?? (async () => unexpected('hasTokenGasOracle')),
    balance: fields.balance ?? (async () => unexpected('balance')),
    fees: fields.fees ?? (async () => unexpected('fees')),
    estimateDeployGas:
      fields.estimateDeployGas ?? (async () => unexpected('estimateDeployGas')),
    l1DataFee: fields.l1DataFee ?? (async () => unexpected('l1DataFee')),
  };
}

describe('ICA and QuotedCalls pair deploy', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('version gate', () => {
    interface Case {
      version: string;
      pair: boolean;
    }
    const cases: Case[] = [
      { version: '5.3.9', pair: false },
      { version: '7.1.10', pair: false },
      { version: '11.3.1', pair: false },
      { version: '12.1.0', pair: false },
      { version: '12.2.0', pair: true },
      { version: '12.10.0', pair: true },
      { version: '13.0.0', pair: true },
    ];
    for (const c of cases) {
      it(`${c.version} is ${c.pair ? 'a pair version' : 'stale'}`, () => {
        expect(isPairVersion(c.version)).to.equal(c.pair);
      });
    }
  });

  describe('candidateAddresses', () => {
    it('lists the registry address before the recorded one', () => {
      expect(candidateAddresses(addr(1), addr(2))).to.deep.equal([
        { address: addr(1), source: CandidateSource.Registry },
        { address: addr(2), source: CandidateSource.Export },
      ]);
    });

    it('drops a recorded address equal to the registry one in any casing', () => {
      expect(
        candidateAddresses(addr(0xabc), addr(0xabc).toLowerCase()),
      ).to.deep.equal([
        { address: addr(0xabc), source: CandidateSource.Registry },
      ]);
    });

    it('lists a pending deploy last and drops it when it is already listed', () => {
      expect(candidateAddresses(addr(1), addr(2), addr(3))).to.deep.equal([
        { address: addr(1), source: CandidateSource.Registry },
        { address: addr(2), source: CandidateSource.Export },
        { address: addr(3), source: CandidateSource.Pending },
      ]);
      expect(candidateAddresses(undefined, addr(2), addr(2))).to.deep.equal([
        { address: addr(2), source: CandidateSource.Export },
      ]);
    });

    it('returns nothing when neither is known', () => {
      expect(candidateAddresses(undefined, undefined)).to.deep.equal([]);
    });
  });

  describe('validateShadowHook', () => {
    const fallbackRouting = {
      hookType: OnchainHookType.FALLBACK_ROUTING,
      mailbox: MAILBOX,
    };

    it('accepts a current fallback routing hook of the mailbox', async () => {
      const reader = fakeReader({
        hasCode: async () => true,
        hookState: async () => fallbackRouting,
        packageVersion: async () => '12.2.0',
      });
      expect(await validateShadowHook(reader, SHADOW, MAILBOX)).to.deep.equal({
        address: SHADOW,
      });
    });

    it('refuses an address without code before reading anything else', async () => {
      const reader = fakeReader({ hasCode: async () => false });
      expect(await validateShadowHook(reader, SHADOW, MAILBOX)).to.deep.equal({
        address: SHADOW,
        problem: 'has no code',
      });
    });

    it('refuses a hook that is not a fallback routing hook', async () => {
      const reader = fakeReader({
        hasCode: async () => true,
        hookState: async () => ({
          hookType: OnchainHookType.ROUTING,
          mailbox: MAILBOX,
        }),
        packageVersion: async () => '12.2.0',
      });
      expect(
        (await validateShadowHook(reader, SHADOW, MAILBOX)).problem,
      ).to.equal(`has hook type ${OnchainHookType.ROUTING}`);
    });

    it('refuses a hook that belongs to another mailbox', async () => {
      const reader = fakeReader({
        hasCode: async () => true,
        hookState: async () => ({
          hookType: OnchainHookType.FALLBACK_ROUTING,
          mailbox: addr(0x99),
        }),
        packageVersion: async () => '12.2.0',
      });
      expect(
        (await validateShadowHook(reader, SHADOW, MAILBOX)).problem,
      ).to.equal(`belongs to mailbox ${addr(0x99)}`);
    });

    it('refuses a hook too old to accept ERC20 fee metadata', async () => {
      const reader = fakeReader({
        hasCode: async () => true,
        hookState: async () => fallbackRouting,
        packageVersion: async () => '11.0.0',
      });
      expect(
        (await validateShadowHook(reader, SHADOW, MAILBOX)).problem,
      ).to.equal('reports version 11.0.0');
    });
  });

  describe('readPendingState', () => {
    const pending = {
      contract: ContractKind.Router,
      address: addr(0x700),
      signer: SIGNER,
      nonce: 5,
    };
    const state = (hasCode: boolean, mined: number) =>
      readPendingState(
        fakeReader({
          hasCode: async () => hasCode,
          minedTransactionCount: async (address) => {
            expect(address).to.equal(SIGNER);
            return mined;
          },
        }),
        pending,
      );

    it('is deployed once the contract exists', async () => {
      expect(await state(true, 0)).to.equal(PendingState.Deployed);
    });

    it('is unmined while the signer has not mined that nonce', async () => {
      expect(await state(false, 4)).to.equal(PendingState.Unmined);
      expect(await state(false, 5)).to.equal(PendingState.Unmined);
    });

    it('is abandoned when the nonce was used without creating the contract', async () => {
      expect(await state(false, 6)).to.equal(PendingState.Abandoned);
    });
  });

  describe('selectRouter', () => {
    const expected = { mailbox: MAILBOX, signer: SIGNER, owner: OWNER };

    it('adopts a current router owned by the signer', () => {
      const candidate = routerCandidate();
      expect(selectRouter([candidate], expected)).to.deep.equal({
        kind: Adoption.Adopt,
        candidate,
      });
    });

    it('adopts a current router already owned by the target owner', () => {
      const candidate = routerCandidate({ owner: OWNER });
      expect(selectRouter([candidate], expected).kind).to.equal(Adoption.Adopt);
    });

    it('prefers the first adoptable candidate', () => {
      const stale = routerCandidate({ version: '7.1.10' });
      const recorded = routerCandidate({
        address: addr(0x101),
        source: CandidateSource.Export,
      });
      const selection = selectRouter([stale, recorded], expected);
      expect(selection.kind === Adoption.Adopt && selection.candidate).to.equal(
        recorded,
      );
    });

    interface Reject {
      name: string;
      candidate: RouterCandidate;
      reason: string;
    }
    const rejections: Reject[] = [
      {
        name: 'a stale version',
        candidate: routerCandidate({ version: '12.1.0' }),
        reason: 'version 12.1.0 is below 12.2.0',
      },
      {
        name: 'another mailbox',
        candidate: routerCandidate({ mailbox: addr(0x99) }),
        reason: `mailbox ${addr(0x99)} is not ${MAILBOX}`,
      },
      {
        name: 'a foreign owner',
        candidate: routerCandidate({ owner: STRANGER }),
        reason: `owner ${STRANGER} is neither the signer nor the target owner`,
      },
    ];
    for (const c of rejections) {
      it(`deploys instead of adopting ${c.name}`, () => {
        expect(selectRouter([c.candidate], expected)).to.deep.equal({
          kind: Adoption.Deploy,
          rejected: [
            {
              address: c.candidate.address,
              source: c.candidate.source,
              reason: c.reason,
            },
          ],
        });
      });
    }

    it('deploys when there is no candidate', () => {
      expect(selectRouter([], expected)).to.deep.equal({
        kind: Adoption.Deploy,
        rejected: [],
      });
    });
  });

  describe('selectQuotedCalls', () => {
    it('adopts a current QuotedCalls on the canonical Permit2', () => {
      const candidate = quotedCallsCandidate();
      expect(selectQuotedCalls([candidate]).kind).to.equal(Adoption.Adopt);
    });

    it('deploys instead of adopting a stale version', () => {
      const selection = selectQuotedCalls([
        quotedCallsCandidate({ version: '11.3.1' }),
      ]);
      expect(
        selection.kind === Adoption.Deploy && selection.rejected[0].reason,
      ).to.equal('version 11.3.1 is below 12.2.0');
    });

    it('deploys instead of adopting another Permit2', () => {
      const selection = selectQuotedCalls([
        quotedCallsCandidate({ permit2: addr(0x77) }),
      ]);
      expect(selection.kind).to.equal(Adoption.Deploy);
    });
  });

  describe('planWiring', () => {
    interface Fields {
      state?: RouterWiringState;
      signer?: Address;
      owner?: Address;
      shadowHook?: ShadowHook;
      allowances?: TokenAllowance[];
      peers?: PeerRouter[];
    }
    const plan = (fields: Fields) =>
      planWiring({
        state: fields.state ?? wiringState(),
        signer: fields.signer ?? SIGNER,
        owner: fields.owner ?? SIGNER,
        shadowHook: fields.shadowHook,
        allowances: fields.allowances ?? [],
        peers: fields.peers ?? [],
      });

    it('sets the hook to a valid shadow hook that differs', () => {
      expect(plan({ shadowHook: { address: SHADOW } }).setHook).to.equal(
        SHADOW,
      );
    });

    it('keeps a hook that already is the shadow hook', () => {
      const result = plan({
        state: wiringState({ hook: SHADOW }),
        shadowHook: { address: SHADOW },
      });
      expect(result.setHook).to.equal(undefined);
    });

    it('keeps the hook and says why when the shadow hook is unusable', () => {
      const result = plan({
        shadowHook: { address: SHADOW, problem: 'has no code' },
      });
      expect(result.setHook).to.equal(undefined);
      expect(result.notes).to.deep.equal([
        `shadow routing hook ${SHADOW} has no code: keeping the current hook`,
      ]);
    });

    it('keeps the mailbox default hook without a shadow hook', () => {
      const result = plan({});
      expect(result.setHook).to.equal(undefined);
      expect(result.notes).to.have.length(1);
    });

    it('approves only the tokens whose allowance is not a standing maximum', () => {
      const result = plan({
        allowances: [
          allowance(USDC, constants.MaxUint256),
          allowance(USDT, BigNumber.from(5)),
        ],
      });
      expect(result.approvals.map(({ token }) => token.symbol)).to.deep.equal([
        'USDT',
      ]);
    });

    it('enrolls peers that are unset, skips matching and reports conflicts', () => {
      const baseRouter = addr(0x301);
      const result = plan({
        state: wiringState({
          remoteRouters: new Map([
            [8453, addressToBytes32(baseRouter)],
            [57073, addressToBytes32(addr(0x999))],
          ]),
        }),
        peers: [
          { chain: 'base', domainId: 8453, router: baseRouter },
          { chain: 'ink', domainId: 57073, router: addr(0x302) },
          { chain: 'bsc', domainId: 56, router: addr(0x303) },
          { chain: 'arc', domainId: 5042 },
        ],
      });
      expect(result.enroll.map(({ peer }) => peer.chain)).to.deep.equal([
        'bsc',
      ]);
      expect(result.conflicts).to.have.length(1);
      expect(result.conflicts[0]).to.include('ink is enrolled as');
      expect(result.awaiting).to.deep.equal(['arc']);
    });

    it('transfers ownership last, only once everything else is done', () => {
      expect(plan({ owner: OWNER }).transferOwnershipTo).to.equal(OWNER);

      const pending = plan({
        owner: OWNER,
        allowances: [allowance(USDC, BigNumber.from(0))],
      });
      expect(pending.transferOwnershipTo).to.equal(undefined);
    });

    it('does not transfer a router the signer no longer owns', () => {
      const result = plan({
        owner: OWNER,
        state: wiringState({ owner: OWNER }),
      });
      expect(result.transferOwnershipTo).to.equal(undefined);
    });
  });

  describe('wiring gas', () => {
    it('counts one enrollment transaction for all unenrolled peers', () => {
      const steps = estimateWiringSteps({
        state: wiringState(),
        signer: SIGNER,
        owner: OWNER,
        shadowHook: { address: SHADOW },
        allowances: [allowance(USDC, BigNumber.from(0))],
        peers: PEERS,
      });
      expect(steps.map(({ name }) => name)).to.deep.equal([
        'setHook',
        'approve USDC',
        'enroll 2 peer(s)',
        'transferOwnership',
      ]);
      expect(steps.map(({ gas }) => gas.toNumber())).to.deep.equal([
        80_000, 120_000, 300_000, 80_000,
      ]);
    });

    it('prices nothing for a finished router', () => {
      const plan = planWiring({
        signer: SIGNER,
        owner: SIGNER,
        state: wiringState({
          remoteRouters: new Map([
            [8453, addressToBytes32(addr(0x301))],
            [57073, addressToBytes32(addr(0x302))],
          ]),
        }),
        allowances: [],
        peers: [
          { chain: 'base', domainId: 8453, router: addr(0x301) },
          { chain: 'ink', domainId: 57073, router: addr(0x302) },
        ],
      });
      expect(wiringGasSteps(plan)).to.deep.equal([]);
    });
  });

  describe('assessFunds', () => {
    const fees = {
      gasPrice: BigNumber.from(10),
      maxFeePerGas: BigNumber.from(100),
    };
    const steps = [
      { name: 'a', gas: BigNumber.from(1000), l1Fee: BigNumber.from(500) },
      { name: 'b', gas: BigNumber.from(2000), l1Fee: BigNumber.from(0) },
    ];

    it('prices the worst case at the buffered gas limit and the max fee', () => {
      const report = assessFunds({
        balance: BigNumber.from(100_000),
        steps,
        fees,
      });
      // expected: (1000 + 2000) * 10 + 500
      expect(report.expected.toNumber()).to.equal(30_500);
      // worst case: (1100 + 2200) * 100 + 500
      expect(report.worstCase.toNumber()).to.equal(330_500);
      // required: worst case * 1.3
      expect(report.required.toNumber()).to.equal(429_650);
      expect(report.shortfall.toNumber()).to.equal(329_650);
    });

    it('has no shortfall when the balance covers the requirement', () => {
      const report = assessFunds({
        balance: BigNumber.from(429_650),
        steps,
        fees,
      });
      expect(report.shortfall.toNumber()).to.equal(0);
    });

    it('is short by one unit when the balance is one below the requirement', () => {
      const report = assessFunds({
        balance: BigNumber.from(429_649),
        steps,
        fees,
      });
      expect(report.shortfall.toNumber()).to.equal(1);
    });
  });

  describe('effectiveFees', () => {
    const suggested = {
      gasPrice: BigNumber.from(10),
      maxFeePerGas: BigNumber.from(100),
    };

    it('keeps the provider suggestion without overrides', () => {
      expect(effectiveFees(suggested, {})).to.deep.equal(suggested);
    });

    it('uses the max fee the chain metadata pins', () => {
      const fees = effectiveFees(suggested, { maxFeePerGas: 60 });
      expect(fees.maxFeePerGas.toNumber()).to.equal(60);
      expect(fees.gasPrice.toNumber()).to.equal(10);
    });

    it('never expects to pay more than the pinned max fee', () => {
      const fees = effectiveFees(suggested, { maxFeePerGas: 5 });
      expect(fees.gasPrice.toNumber()).to.equal(5);
    });

    it('uses a pinned legacy gas price for both', () => {
      const fees = effectiveFees(suggested, { gasPrice: 7 });
      expect(fees.maxFeePerGas.toNumber()).to.equal(7);
      expect(fees.gasPrice.toNumber()).to.equal(7);
    });
  });

  describe('signer key from the environment', () => {
    const key = utils.hexlify(utils.randomBytes(32));
    const bareKey = key.slice(2);

    it('derives the wallet from a 0x prefixed key', () => {
      const wallet = loadWalletFromEnv('ICA_KEY', { ICA_KEY: key });
      expect(wallet.address).to.equal(new Wallet(key).address);
    });

    it('accepts a key without the prefix', () => {
      const wallet = loadWalletFromEnv('ICA_KEY', { ICA_KEY: bareKey });
      expect(wallet.address).to.equal(new Wallet(key).address);
    });

    it('names an unset variable without more detail', () => {
      expect(messageOf(() => loadWalletFromEnv('ICA_KEY', {}))).to.equal(
        'ICA_KEY is not set',
      );
    });

    it('never repeats a malformed value', () => {
      const secret = 'not-a-key-but-secret';
      const message = messageOf(() =>
        loadWalletFromEnv('ICA_KEY', { ICA_KEY: secret }),
      );
      expect(message).to.equal(
        'ICA_KEY does not hold a 32-byte hex private key',
      );
      expect(message).to.not.include(secret);
    });

    const keyAsName = [key, bareKey, `a${bareKey.slice(1)}`];
    for (const name of keyAsName) {
      it(`rejects a key passed as the variable name without echoing it (${name.slice(0, 4)}...)`, () => {
        const message = messageOf(() =>
          loadWalletFromEnv(name, { [name]: key }),
        );
        expect(message).to.include('not the key itself');
        expect(message).to.not.include(name);
      });
    }

    it('rejects a name that is not an environment variable name', () => {
      expect(messageOf(() => loadWalletFromEnv('has space', {}))).to.include(
        'not the key itself',
      );
    });

    it('redacts the key with and without the prefix and keeps the rest', () => {
      const wallet = new Wallet(key);
      const redact = createKeyRedactor(wallet);
      expect(redact(`bad ${key} and 0X${bareKey.toUpperCase()}`)).to.equal(
        `bad ${REDACTED_KEY} and ${REDACTED_KEY}`,
      );
      expect(redact(`${wallet.address} sent 0xabc`)).to.equal(
        `${wallet.address} sent 0xabc`,
      );
    });

    it('describes errors through the redactor and the url redaction', () => {
      const redact = createKeyRedactor(new Wallet(key));
      const text = describeIcaError(
        new Error(`failed at https://host/${key} with ${key}`),
        redact,
      );
      expect(text).to.not.include(key);
      expect(text).to.not.include('host');
    });

    it('does not redact without a key', () => {
      expect(createKeyRedactor(undefined)('text')).to.equal('text');
    });
  });

  describe('--owner', () => {
    it('checksums a valid address', () => {
      expect(parseOwner(OWNER.toLowerCase())).to.equal(OWNER);
    });

    it('refuses the zero address', () => {
      expect(() => parseOwner(constants.AddressZero)).to.throw(
        '--owner must not be the zero address',
      );
    });

    it('refuses a mixed-case address with a bad checksum', () => {
      const checksummed = utils.getAddress(`0x${'ab'.repeat(20)}`);
      const broken = checksummed.replace(/[a-fA-F]/, (letter) =>
        letter === letter.toUpperCase()
          ? letter.toLowerCase()
          : letter.toUpperCase(),
      );
      expect(broken).to.not.equal(checksummed);
      expect(broken).to.not.equal(broken.toLowerCase());
      expect(() => parseOwner(broken)).to.throw(
        '--owner must be an EVM address',
      );
    });

    it('refuses what is not an address', () => {
      for (const value of ['', '0x1234', 'owner']) {
        expect(() => parseOwner(value), value).to.throw(
          '--owner must be an EVM address',
        );
      }
    });
  });

  describe('--fee-tokens', () => {
    const ROUTE_CHAINS = [
      'arbitrum',
      'arc',
      'base',
      'bsc',
      'ethereum',
      'ink',
      'optimism',
    ];
    const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const fixturePath = fileURLToPath(
      new URL(
        './fixtures/ica-quoted-calls-test-fee-tokens.yaml',
        import.meta.url,
      ),
    );
    let dir: string;
    let written = 0;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'ica-fee-tokens-'));
    });

    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function writeTokensFile(content: string): string {
      const file = join(dir, `fee-tokens-${written++}.yaml`);
      writeFileSync(file, content);
      return file;
    }

    const entry = (address: string) =>
      `base:\n  - address: ${address}\n    symbol: USDC\n`;

    it('loads the fee tokens of the token IGP test routes on every route chain', () => {
      const token = (symbol: string, address: string): FeeToken => ({
        symbol,
        address: utils.getAddress(address),
      });
      expect(loadFeeTokens(fixturePath, ROUTE_CHAINS)).to.deep.equal({
        arbitrum: [
          token('USDC', warpTokens.arbitrum.USDC),
          token('USDT', warpTokens.arbitrum.USDT),
        ],
        arc: [token('USDC', warpTokens.arc.USDC)],
        base: [
          token('USDC', warpTokens.base.USDC),
          token('USDT', warpTokens.base.USDT),
        ],
        bsc: [],
        ethereum: [
          token('USDC', warpTokens.ethereum.USDC),
          token('USDT', warpTokens.ethereum.USDT),
        ],
        ink: [
          token('USDC', warpTokens.ink.USDC),
          token('USDT', warpTokens.ink.USDT0),
        ],
        optimism: [
          token('USDC', warpTokens.optimism.USDC),
          token('USDT', warpTokens.optimism.USDT),
        ],
      });
    });

    it('returns only the target chains from a larger file', () => {
      expect(loadFeeTokens(fixturePath, ['base'])).to.deep.equal({
        base: [
          { symbol: 'USDC', address: BASE_USDC },
          {
            symbol: 'USDT',
            address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
          },
        ],
      });
    });

    it('gives a target chain without an entry no fee tokens', () => {
      expect(loadFeeTokens(fixturePath, ['mantle'])).to.deep.equal({
        mantle: [],
      });
    });

    it('accepts an empty list for a chain', () => {
      const file = writeTokensFile('bsc: []\n');
      expect(loadFeeTokens(file, ['bsc'])).to.deep.equal({ bsc: [] });
    });

    it('loads a JSON file', () => {
      const file = writeTokensFile(
        JSON.stringify({ base: [{ symbol: 'USDC', address: BASE_USDC }] }),
      );
      expect(loadFeeTokens(file, ['base'])).to.deep.equal({
        base: [{ symbol: 'USDC', address: BASE_USDC }],
      });
    });

    it('checksums a lowercase address', () => {
      const file = writeTokensFile(entry(`'${BASE_USDC.toLowerCase()}'`));
      expect(loadFeeTokens(file, ['base'])).to.deep.equal({
        base: [{ symbol: 'USDC', address: BASE_USDC }],
      });
    });

    interface Case {
      name: string;
      content?: string;
      error: string;
      raw?: string;
    }
    const BAD_CHECKSUM = '0xa0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const cases: Case[] = [
      {
        name: 'a file that does not exist',
        error: "File doesn't exist at",
      },
      {
        name: 'malformed YAML',
        content: 'base: [',
        error: 'at line 1',
      },
      {
        name: 'an empty file',
        content: '',
        error:
          'with the address quoted: Invalid input: expected record, received null',
      },
      {
        name: 'a list instead of a chain map',
        content: '- base\n',
        error: 'expected record, received array',
      },
      {
        name: 'a chain whose value is not a list',
        content: 'base: USDC\n',
        error: 'base: Invalid input: expected array, received string',
      },
      {
        name: 'a token without a symbol',
        content: `base:\n  - address: '${BASE_USDC}'\n`,
        error: 'base.0.symbol: Invalid input: expected string',
      },
      {
        name: 'a token with an empty symbol',
        content: `base:\n  - address: '${BASE_USDC}'\n    symbol: ''\n`,
        error:
          'base.0.symbol: Too small: expected string to have >=1 characters',
      },
      {
        name: 'a token with an unknown field',
        content: `base:\n  - address: '${BASE_USDC}'\n    decimals: 6\n    symbol: USDC\n`,
        error: 'Unrecognized key: "decimals"',
      },
      {
        name: 'an unquoted address that YAML reads as a number',
        content: entry(BASE_USDC),
        error:
          'base.0.address: Invalid input: expected string, received number',
        raw: BASE_USDC,
      },
      {
        name: 'an invalid address',
        content: entry("'0x1234'"),
        error: 'the USDC fee token on base is not a valid EVM address',
        raw: '0x1234',
      },
      {
        name: 'an address with a bad checksum',
        content: entry(`'${BAD_CHECKSUM}'`),
        error: 'the USDC fee token on base is not a valid EVM address',
        raw: BAD_CHECKSUM,
      },
      {
        name: 'the zero address',
        content: entry(`'${constants.AddressZero}'`),
        error: 'the USDC fee token on base must not be the zero address',
        raw: constants.AddressZero,
      },
      {
        name: 'an invalid address on a chain outside the run',
        content: `ink:\n  - address: '0x1234'\n    symbol: USDT\n`,
        error: 'the USDT fee token on ink is not a valid EVM address',
        raw: '0x1234',
      },
    ];
    for (const c of cases) {
      it(`rejects ${c.name}`, () => {
        const file =
          c.content === undefined
            ? join(dir, 'missing.yaml')
            : writeTokensFile(c.content);
        const message = messageOf(() => loadFeeTokens(file, ['base']));
        expect(message).to.include(c.error);
        if (c.raw !== undefined) {
          expect(message).to.not.include(c.raw);
        }
      });
    }
  });

  describe('assertDeployableChains', () => {
    const support =
      (protocol: ProtocolType, hasMailbox = true) =>
      () => ({
        protocol,
        hasMailbox,
      });

    it('accepts standard EVM chains with a registered mailbox', () => {
      expect(() =>
        assertDeployableChains(['base'], support(ProtocolType.Ethereum)),
      ).to.not.throw();
    });

    it('refuses a chain on another protocol', () => {
      expect(() =>
        assertDeployableChains(['osmosis'], support(ProtocolType.Cosmos)),
      ).to.throw('osmosis uses protocol cosmos: only standard EVM chains');
    });

    it('refuses a chain without a mailbox in the registry', () => {
      expect(() =>
        assertDeployableChains(['base'], support(ProtocolType.Ethereum, false)),
      ).to.throw('base has no mailbox in the registry');
    });
  });

  describe('priority fee', () => {
    it('parses gwei into wei', () => {
      expect(parsePriorityFeeGwei('0.001').toString()).to.equal('1000000');
      expect(parsePriorityFeeGwei('2').toString()).to.equal('2000000000');
    });

    it('rejects a value that is not a plain decimal number', () => {
      for (const value of ['-1', '1e3', 'abc', '0.0000000001', '']) {
        expect(() => parsePriorityFeeGwei(value), value).to.throw(
          '--priority-fee-gwei',
        );
      }
    });

    it('keeps the signers of the provider it extends', async () => {
      const wallet = Wallet.createRandom();
      const base = MultiProvider.createTestMultiProvider();
      base.setSigner('test1', wallet);
      sinon.stub(base.getProvider('test1'), 'getBlock').resolves(block());

      const extended = await withPriorityFee(
        base,
        ['test1'],
        BigNumber.from(7),
      );

      expect(await extended.multiProvider.getSignerAddress('test1')).to.equal(
        wallet.address,
      );
    });

    it('keeps a fee the chain metadata pins, whatever shape the pin has', async () => {
      const arcPin = {
        maxFeePerGas: 60_000_000_000,
        maxPriorityFeePerGas: 2_000_000_000,
        gasLimit: 123,
      };
      const legacyPin = { gasPrice: 100_000_000 };
      const base = MultiProvider.createTestMultiProvider().extendChainMetadata({
        test1: { transactionOverrides: arcPin },
        test2: { transactionOverrides: legacyPin },
      });
      sinon
        .stub(base.getProvider('test3'), 'getBlock')
        .resolves(block(BigNumber.from(1000)));
      const getBlock = sinon.stub(base.getProvider('test1'), 'getBlock');

      const extended = await withPriorityFee(
        base,
        ['test1', 'test2', 'test3'],
        BigNumber.from(7),
      );

      expect(extended.pinned).to.deep.equal(['test1', 'test2']);
      expect(
        extended.multiProvider.getChainMetadata('test1').transactionOverrides,
      ).to.deep.equal(arcPin);
      expect(
        extended.multiProvider.getChainMetadata('test2').transactionOverrides,
      ).to.deep.equal(legacyPin);
      expect(getBlock.callCount).to.equal(0);
      expect(
        extended.multiProvider.getTransactionOverrides('test3'),
      ).to.deep.include({ maxFeePerGas: '2007' });
    });

    it('keeps the other transaction overrides of a chain it sets the fee on', async () => {
      const base = MultiProvider.createTestMultiProvider().extendChainMetadata({
        test1: {
          transactionOverrides: {
            gasLimit: 123,
            deploymentGasLimitFallback: 5,
          },
        },
      });
      sinon
        .stub(base.getProvider('test1'), 'getBlock')
        .resolves(block(BigNumber.from(1000)));

      const extended = await withPriorityFee(
        base,
        ['test1'],
        BigNumber.from(7),
      );

      expect(extended.pinned).to.deep.equal([]);
      expect(
        extended.multiProvider.getChainMetadata('test1').transactionOverrides,
      ).to.deep.equal({
        gasLimit: 123,
        deploymentGasLimitFallback: 5,
        maxFeePerGas: '2007',
        maxPriorityFeePerGas: '7',
      });
    });

    it('pins max fee to twice the base fee above the tip, only where a base fee exists', async () => {
      const base = MultiProvider.createTestMultiProvider();
      const withBaseFee = base.getProvider('test1');
      const legacy = base.getProvider('test2');
      sinon.stub(withBaseFee, 'getBlock').resolves(block(BigNumber.from(1000)));
      sinon.stub(legacy, 'getBlock').resolves(block());

      const extended = await withPriorityFee(
        base,
        ['test1', 'test2'],
        BigNumber.from(7),
      );

      expect(
        extended.multiProvider.getTransactionOverrides('test1'),
      ).to.deep.include({
        maxFeePerGas: '2007',
        maxPriorityFeePerGas: '7',
      });
      expect(
        extended.multiProvider.getTransactionOverrides('test2'),
      ).to.not.have.property('maxFeePerGas');
    });
  });

  describe('export', () => {
    const NOW = '2026-10-08T00:00:00.000Z';
    const LATER = '2026-10-09T00:00:00.000Z';
    const router = (n: number) => ({ address: addr(n), version: '12.2.0' });
    const identity = {
      signer: SIGNER,
      owner: OWNER,
      registryBefore: { interchainAccountRouterV3: addr(0x900) },
    };

    function update(
      fields: Partial<IcaChainExportUpdate>,
    ): IcaChainExportUpdate {
      return {
        signer: fields.signer ?? identity.signer,
        owner: fields.owner ?? identity.owner,
        registryBefore: fields.registryBefore ?? identity.registryBefore,
        router: fields.router,
        quotedCalls: fields.quotedCalls,
        hook: fields.hook,
        approvals: fields.approvals,
        enrolledPeers: fields.enrolledPeers,
        pending: fields.pending,
        clearPending: fields.clearPending,
      };
    }

    it('records the registry as it was on the first write and never again', () => {
      const first = mergeIcaExport(
        undefined,
        update({ router: router(1) }),
        NOW,
      );
      expect(first.entry.registryBefore).to.deep.equal(identity.registryBefore);
      expect(first.entry.firstRecordedAt).to.equal(NOW);

      const second = mergeIcaExport(
        first.entry,
        update({ registryBefore: { interchainAccountRouterV3: addr(0x901) } }),
        LATER,
      );
      expect(second.entry.registryBefore).to.deep.equal(
        identity.registryBefore,
      );
      expect(second.entry.firstRecordedAt).to.equal(NOW);
    });

    it('reports an identical update as unchanged and keeps its timestamp', () => {
      const first = mergeIcaExport(
        undefined,
        update({ router: router(1) }),
        NOW,
      );
      const again = mergeIcaExport(
        first.entry,
        update({ router: router(1) }),
        LATER,
      );
      expect(again.changed).to.equal(false);
      expect(again.entry.updatedAt).to.equal(NOW);
    });

    it('unions approvals and enrolled peers without duplicates', () => {
      const a = { feeToken: addr(0x20), spender: addr(0x11) };
      const b = { feeToken: addr(0x21), spender: addr(0x11) };
      let entry = mergeIcaExport(
        undefined,
        update({ router: router(1), approvals: [a], enrolledPeers: ['ink'] }),
        NOW,
      ).entry;
      entry = mergeIcaExport(
        entry,
        update({
          approvals: [
            { feeToken: a.feeToken.toLowerCase(), spender: a.spender },
            b,
          ],
          enrolledPeers: ['base', 'ink'],
        }),
        LATER,
      ).entry;
      expect(entry.approvals).to.deep.equal([a, b]);
      expect(entry.enrolledPeers).to.deep.equal(['base', 'ink']);
    });

    it('starts the hook, approvals and enrollments over for a new router', () => {
      const first = mergeIcaExport(
        undefined,
        update({
          router: router(1),
          quotedCalls: {
            address: addr(0x2),
            version: '12.2.0',
            permit2: addr(0x3),
          },
          hook: SHADOW,
          approvals: [{ feeToken: addr(0x20), spender: addr(0x11) }],
          enrolledPeers: ['base'],
        }),
        NOW,
      ).entry;
      const replaced = mergeIcaExport(
        first,
        update({ router: router(5) }),
        LATER,
      ).entry;
      expect(replaced.router?.address).to.equal(addr(5));
      expect(replaced.hook).to.equal(undefined);
      expect(replaced.approvals).to.deep.equal([]);
      expect(replaced.enrolledPeers).to.deep.equal([]);
      expect(replaced.quotedCalls?.address).to.equal(addr(0x2));
    });

    it('keeps the deploy transaction hash when a rerun adopts the contract', () => {
      const deployed = mergeIcaExport(
        undefined,
        update({
          router: {
            address: addr(1),
            version: '12.2.0',
            deployTxHash: '0xdead',
          },
          quotedCalls: {
            address: addr(2),
            version: '12.2.0',
            permit2: addr(3),
            deployTxHash: '0xbeef',
          },
        }),
        NOW,
      );
      const adopted = mergeIcaExport(
        deployed.entry,
        update({
          router: router(1),
          quotedCalls: {
            address: addr(2),
            version: '12.2.0',
            permit2: addr(3),
          },
        }),
        LATER,
      );
      expect(adopted.changed).to.equal(false);
      expect(adopted.entry.router?.deployTxHash).to.equal('0xdead');
      expect(adopted.entry.quotedCalls?.deployTxHash).to.equal('0xbeef');
      expect(adopted.entry.updatedAt).to.equal(NOW);
    });

    it('keeps a replaced router and QuotedCalls on the superseded list', () => {
      const first = mergeIcaExport(
        undefined,
        update({
          router: {
            address: addr(1),
            version: '12.2.0',
            deployTxHash: '0xdead',
          },
          quotedCalls: {
            address: addr(2),
            version: '12.2.0',
            permit2: addr(3),
          },
        }),
        NOW,
      ).entry;
      const replaced = mergeIcaExport(
        first,
        update({
          router: router(5),
          quotedCalls: {
            address: addr(6),
            version: '12.2.0',
            permit2: addr(3),
          },
        }),
        LATER,
      ).entry;
      expect(replaced.superseded).to.deep.equal([
        {
          contract: ContractKind.Router,
          address: addr(1),
          version: '12.2.0',
          deployTxHash: '0xdead',
        },
        {
          contract: ContractKind.QuotedCalls,
          address: addr(2),
          version: '12.2.0',
        },
      ]);
      const again = mergeIcaExport(
        replaced,
        update({ router: router(5) }),
        LATER,
      );
      expect(again.entry.superseded).to.have.length(2);
    });

    it('tracks a pending deploy until its contract is recorded or it is cleared', () => {
      const pendingRouter = {
        contract: ContractKind.Router,
        address: addr(0x700),
        signer: SIGNER,
        nonce: 3,
      };
      const pendingQuotedCalls = {
        contract: ContractKind.QuotedCalls,
        address: addr(0x701),
        signer: SIGNER,
        nonce: 4,
      };
      let entry = mergeIcaExport(
        undefined,
        update({ pending: pendingRouter }),
        NOW,
      ).entry;
      entry = mergeIcaExport(
        entry,
        update({ pending: pendingQuotedCalls }),
        NOW,
      ).entry;
      expect(entry.pending).to.deep.equal(
        [pendingQuotedCalls, pendingRouter].sort((a, b) =>
          a.contract.localeCompare(b.contract),
        ),
      );

      const recorded = mergeIcaExport(
        entry,
        update({ router: router(0x700) }),
        LATER,
      ).entry;
      expect(recorded.pending).to.deep.equal([pendingQuotedCalls]);

      const cleared = mergeIcaExport(
        recorded,
        update({ clearPending: ContractKind.QuotedCalls }),
        LATER,
      ).entry;
      expect(cleared.pending).to.deep.equal([]);
    });

    it('serves updates from the memory store', async () => {
      const store = createMemoryChainStore<
        IcaChainExport,
        IcaChainExportUpdate
      >(mergeIcaExport);
      await store.update('base', update({ router: router(1) }), NOW);
      expect((await store.read('base'))?.router?.address).to.equal(addr(1));
      expect(await store.read('ink')).to.equal(undefined);
    });

    it('persists concurrent per-chain updates to the file store', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ica-export-'));
      try {
        const file = join(dir, 'nested', 'addresses.json');
        const store = createFileChainStore<
          IcaChainExport,
          IcaChainExportUpdate
        >(file, mergeIcaExport);
        await Promise.all(
          ['ink', 'base', 'arbitrum', 'optimism'].map((chain, index) =>
            store.update(chain, update({ router: router(index + 1) }), NOW),
          ),
        );
        const written = JSON.parse(readFileSync(file, 'utf8'));
        expect(Object.keys(written)).to.deep.equal([
          'arbitrum',
          'base',
          'ink',
          'optimism',
        ]);
        expect(written.ink.router.address).to.equal(addr(1));
        expect((await store.read('optimism'))?.router?.address).to.equal(
          addr(4),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('summary', () => {
    it('prints how to put the registry back after writing it', () => {
      const lines: string[] = [];
      sinon.stub(console, 'info').callsFake((line: string) => {
        lines.push(line);
      });
      sinon.stub(console, 'table');
      const written: ChainResult = {
        chain: 'base',
        outcome: IcaOutcome.Applied,
        rejected: [],
        enrolledPeers: [],
        approved: [],
        registryKeysWritten: ['interchainAccountRouterV3', 'quotedCallsV3'],
        registryBefore: { interchainAccountRouterV3: addr(0x900) },
        pending: [],
        notes: [],
        problems: [],
      };

      printSummary([written]);

      expect(lines).to.include(
        '  registry updated: interchainAccountRouterV3, quotedCallsV3',
      );
      expect(lines.join('\n')).to.include(
        `interchainAccountRouterV3: ${addr(0x900)}, quotedCallsV3: (absent)`,
      );
    });
  });

  describe('exit code', () => {
    const result = (outcome: IcaOutcome): ChainResult => ({
      chain: 'test1',
      outcome,
      rejected: [],
      enrolledPeers: [],
      approved: [],
      registryKeysWritten: [],
      pending: [],
      notes: [],
      problems: [],
    });

    it('fails on an error', () => {
      expect(
        computeExitCode([result(IcaOutcome.Error)], { apply: false }),
      ).to.equal(1);
    });

    it('reports insufficient funds as a failure only when applying', () => {
      const results = [result(IcaOutcome.InsufficientFunds)];
      expect(computeExitCode(results, { apply: false })).to.equal(0);
      expect(computeExitCode(results, { apply: true })).to.equal(1);
    });

    it('treats a chain still waiting for a peer router as unfinished only when applying', () => {
      const waiting: ChainResult = {
        chain: 'test1',
        outcome: IcaOutcome.Applied,
        rejected: [],
        enrolledPeers: [],
        approved: [],
        registryKeysWritten: [],
        pending: [],
        notes: [],
        problems: [],
        wiring: {
          approvals: [],
          enroll: [],
          awaiting: ['test2'],
          conflicts: [],
          notes: [],
        },
      };
      expect(computeExitCode([waiting], { apply: true })).to.equal(1);
      expect(computeExitCode([waiting], { apply: false })).to.equal(0);
    });

    it('succeeds for planned, applied, up-to-date and skipped chains', () => {
      const results = [
        result(IcaOutcome.Planned),
        result(IcaOutcome.Applied),
        result(IcaOutcome.UpToDate),
        result(IcaOutcome.Skipped),
      ];
      expect(computeExitCode(results, { apply: true })).to.equal(0);
    });
  });
});
