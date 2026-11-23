import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { constants, utils } from 'ethers';
import sinon from 'sinon';

import { IXERC20Lockbox__factory, Ownable__factory } from '@hyperlane-xyz/core';
import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  AEVO_OWNER_SELECTORS,
  AEVO_SELECTORS,
  abiWord,
  aevoRaw,
  aevoUnauthorized,
  aevoUnlimited,
} from '../test/aevoTokenFixture.js';
import { OwnableConfig } from '../types.js';

import {
  EvmXERC20Module,
  XERC20ModuleConfig,
  transferAevoOwnershipTransactions,
} from './EvmXERC20Module.js';
import {
  AevoXERC20Limits,
  EvmXERC20Reader,
  StandardXERC20Limits,
  VeloXERC20Limits,
} from './EvmXERC20Reader.js';
import { TokenType } from './config.js';
import { XERC20LimitsTokenConfig, XERC20Type } from './types.js';

chai.use(chaiAsPromised);

const XERC20_ADDRESS = '0x1111111111111111111111111111111111111111';
const WARP_ROUTE_ADDRESS = '0x5555555555555555555555555555555555555555';
const BRIDGE_ADDRESS_1 = '0x2222222222222222222222222222222222222222';
const EXTRA_BRIDGE_ADDRESS = '0x4444444444444444444444444444444444444444';
const LOCKBOX_ADDRESS = '0x3333333333333333333333333333333333333333';
const XERC20_FROM_LOCKBOX = '0x7777777777777777777777777777777777777777';
const OWNER_ADDRESS = '0x8888888888888888888888888888888888888888';
const NEW_OWNER_ADDRESS = '0x9999999999999999999999999999999999999999';
const PROXY_ADMIN_ADDRESS = '0xaaaaAAaaaaaAAAAaAaaaAaAaAAAaaAAaaaAAAAAa';

const ownableInterface = Ownable__factory.createInterface();

const word = abiWord;
const UPDATE_AUTHORITY_SELECTOR = AEVO_SELECTORS.updateAuthority;
const SET_CAP_SELECTOR = AEVO_SELECTORS.setCap;
const SET_OWNER_SELECTOR = AEVO_OWNER_SELECTORS.setOwner;

// The selectors the other token types are called with, written out from their
// signatures.
const selectorOf = (signature: string) => utils.id(signature).slice(0, 10);
const SET_LIMITS_SELECTOR = selectorOf('setLimits(address,uint256,uint256)');
const SET_BUFFER_CAP_SELECTOR = selectorOf('setBufferCap(address,uint256)');
const SET_RATE_LIMIT_SELECTOR = selectorOf(
  'setRateLimitPerSecond(address,uint128)',
);
const TRANSFER_OWNERSHIP_SELECTOR = selectorOf('transferOwnership(address)');
const RENOUNCE_OWNERSHIP_SELECTOR = selectorOf('renounceOwnership()');

// Decode the transferOwnership(address) argument so tests assert the tx actually
// hands ownership to the expected address, not just that the annotation says so.
function decodeTransferOwnershipTarget(data: string | undefined): string {
  if (data == null) {
    expect.fail('ownership tx must carry calldata');
  }
  const [newOwner] = ownableInterface.decodeFunctionData(
    'transferOwnership',
    data,
  );
  return newOwner;
}

describe('transferAevoOwnershipTransactions', () => {
  const CHAIN_ID = 31337;

  interface NoOpCase {
    name: string;
    actual: Address;
    expected: Address;
  }

  const noOpCases: NoOpCase[] = [
    {
      name: 'the owners are the same',
      actual: OWNER_ADDRESS,
      expected: OWNER_ADDRESS,
    },
    {
      // The reader reports an owner checksummed, a config may write it in any
      // case.
      name: 'the owners are the same in another case',
      actual: PROXY_ADMIN_ADDRESS,
      expected: PROXY_ADMIN_ADDRESS.toLowerCase(),
    },
    {
      name: 'both owners are the zero address',
      actual: constants.AddressZero,
      expected: constants.AddressZero,
    },
    {
      name: 'both owners are the zero address, written differently',
      actual: constants.AddressZero,
      expected: constants.HashZero,
    },
  ];

  for (const c of noOpCases) {
    it(`emits nothing when ${c.name}`, () => {
      expect(
        transferAevoOwnershipTransactions(
          CHAIN_ID,
          XERC20_ADDRESS,
          { owner: c.actual },
          { owner: c.expected },
        ),
      ).to.deep.equal([]);
    });
  }

  it('hands the token to the expected owner with setOwner', () => {
    const txs = transferAevoOwnershipTransactions(
      CHAIN_ID,
      XERC20_ADDRESS,
      { owner: OWNER_ADDRESS },
      { owner: NEW_OWNER_ADDRESS },
      'XERC20 token',
    );

    expect(
      txs.map(({ chainId, to, data }) => ({ chainId, to, data })),
    ).to.deep.equal([
      {
        chainId: CHAIN_ID,
        to: XERC20_ADDRESS,
        data: `${SET_OWNER_SELECTOR}${word(NEW_OWNER_ADDRESS)}`,
      },
    ]);
    expect(txs[0].annotation).to.include(
      'Transferring ownership of XERC20 token',
    );
  });

  it('refuses to renounce the ownership of the token, whose setOwner reverts on the zero address', () => {
    expect(() =>
      transferAevoOwnershipTransactions(
        CHAIN_ID,
        XERC20_ADDRESS,
        { owner: OWNER_ADDRESS },
        { owner: constants.AddressZero },
      ),
    ).to.throw(
      `${XERC20_ADDRESS} is an aevo token, whose ownership cannot be renounced`,
    );
  });
});

describe('EvmXERC20Module', () => {
  let multiProvider: MultiProvider;
  let sandbox: sinon.SinonSandbox;

  const createStandardConfig = (): XERC20ModuleConfig => ({
    type: XERC20Type.Standard,
    limits: {
      [WARP_ROUTE_ADDRESS]: {
        type: XERC20Type.Standard,
        mint: '1000000000000000000',
        burn: '500000000000000000',
      },
      [EXTRA_BRIDGE_ADDRESS]: {
        type: XERC20Type.Standard,
        mint: '2000000000000000000',
        burn: '1000000000000000000',
      },
    },
  });

  const createVeloConfig = (): XERC20ModuleConfig => ({
    type: XERC20Type.Velo,
    limits: {
      [WARP_ROUTE_ADDRESS]: {
        type: XERC20Type.Velo,
        bufferCap: '1000000000000000000',
        rateLimitPerSecond: '100000000000000000',
      },
      [EXTRA_BRIDGE_ADDRESS]: {
        type: XERC20Type.Velo,
        bufferCap: '2000000000000000000',
        rateLimitPerSecond: '200000000000000000',
      },
    },
  });

  const createModule = (config: XERC20ModuleConfig): EvmXERC20Module => {
    return new EvmXERC20Module(multiProvider, {
      addresses: {
        xERC20: XERC20_ADDRESS,
        warpRoute: WARP_ROUTE_ADDRESS,
      },
      chain: TestChainName.test1,
      config,
    });
  };

  const createAevoConfig = (limits: AevoXERC20Limits): XERC20ModuleConfig => ({
    type: XERC20Type.Aevo,
    limits: { [WARP_ROUTE_ADDRESS]: limits },
  });

  // What the token reports: the limits it holds and the owner it has.
  const stubChain = (
    module: EvmXERC20Module,
    limits: XERC20ModuleConfig['limits'],
    type: XERC20Type = XERC20Type.Aevo,
    owner: Address = OWNER_ADDRESS,
  ) => {
    sandbox.stub(module.reader, 'deriveXERC20TokenType').resolves(type);
    sandbox.stub(module.reader, 'readOwner').resolves(owner);
    sandbox.stub(module.reader, 'readProxyAdmin').resolves(undefined);
    sandbox.stub(module.reader, 'readOnChainBridges').resolves([]);
    sandbox.stub(module.reader, 'readLimits').resolves(limits);
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('constructor', () => {
    it('creates module with standard config', () => {
      const config = createStandardConfig();
      const module = createModule(config);

      expect(module.chainName).to.equal(TestChainName.test1);
      expect(module.reader).to.be.instanceOf(EvmXERC20Reader);
    });

    it('creates module with velodrome config', () => {
      const config = createVeloConfig();
      const module = createModule(config);

      expect(module.chainName).to.equal(TestChainName.test1);
    });
  });

  describe('generateSetLimitsTxs', () => {
    it('generates setLimits tx for Standard XERC20', async () => {
      const config = createStandardConfig();
      const module = createModule(config);

      const limits: StandardXERC20Limits = {
        type: XERC20Type.Standard,
        mint: '1000000000000000000',
        burn: '500000000000000000',
      };

      const txs = await module.generateSetLimitsTxs(BRIDGE_ADDRESS_1, limits);

      expect(txs).to.have.lengthOf(1);
      expect(txs[0].annotation).to.include('XERC20 limit update');
      expect(txs[0].chainId).to.equal(
        multiProvider.getEvmChainId(TestChainName.test1),
      );
    });

    it('generates bufferCap and rateLimitPerSecond txs for Velodrome XERC20', async () => {
      const config = createVeloConfig();
      const module = createModule(config);

      const limits: VeloXERC20Limits = {
        type: XERC20Type.Velo,
        bufferCap: '1000000000000000000',
        rateLimitPerSecond: '100000000000000000',
      };

      const txs = await module.generateSetLimitsTxs(BRIDGE_ADDRESS_1, limits);

      expect(txs).to.have.lengthOf(2);
      expect(txs[0].annotation).to.include('XERC20 limit update');
      expect(txs[1].annotation).to.include('XERC20 limit update');
    });
  });

  describe('generateAddBridgeTxs', () => {
    it('delegates to generateSetLimitsTxs for Standard XERC20', async () => {
      const config = createStandardConfig();
      const module = createModule(config);

      const limits: StandardXERC20Limits = {
        type: XERC20Type.Standard,
        mint: '1000000000000000000',
        burn: '500000000000000000',
      };

      const txs = await module.generateAddBridgeTxs(BRIDGE_ADDRESS_1, limits);

      expect(txs).to.have.lengthOf(1);
    });

    it('generates addBridge tx for Velodrome XERC20', async () => {
      const config = createVeloConfig();
      const module = createModule(config);

      const limits: VeloXERC20Limits = {
        type: XERC20Type.Velo,
        bufferCap: '1000000000000000000',
        rateLimitPerSecond: '100000000000000000',
      };

      const txs = await module.generateAddBridgeTxs(BRIDGE_ADDRESS_1, limits);

      expect(txs).to.have.lengthOf(1);
      expect(txs[0].annotation).to.include('XERC20 limit update');
    });
  });

  describe('generateRemoveBridgeTxs', () => {
    it('generates removeBridge tx for Velodrome XERC20', async () => {
      const config = createVeloConfig();
      const module = createModule(config);

      const txs = await module.generateRemoveBridgeTxs(BRIDGE_ADDRESS_1);

      expect(txs).to.have.lengthOf(1);
      expect(txs[0].annotation).to.include('XERC20 limit update');
    });
  });

  describe('update', () => {
    it('returns empty array when no drift detected', async () => {
      const config = createStandardConfig();
      const module = createModule(config);

      sandbox
        .stub(module.reader, 'deriveXERC20TokenType')
        .resolves(XERC20Type.Standard);
      sandbox.stub(module.reader, 'readOwner').resolves(OWNER_ADDRESS);
      sandbox.stub(module.reader, 'readProxyAdmin').resolves(undefined);
      sandbox.stub(module.reader, 'readLimits').resolves(config.limits);

      const txs = await module.update(config);

      expect(txs).to.have.lengthOf(0);
    });

    it('generates txs for missing bridges', async () => {
      const config = createStandardConfig();
      const module = createModule(config);

      sandbox
        .stub(module.reader, 'deriveXERC20TokenType')
        .resolves(XERC20Type.Standard);
      sandbox.stub(module.reader, 'readOwner').resolves(OWNER_ADDRESS);
      sandbox.stub(module.reader, 'readProxyAdmin').resolves(undefined);
      sandbox.stub(module.reader, 'readLimits').resolves({
        [WARP_ROUTE_ADDRESS]: {
          type: XERC20Type.Standard,
          mint: '1000000000000000000',
          burn: '500000000000000000',
        },
      });

      const txs = await module.update(config);

      expect(txs.length).to.be.greaterThan(0);
    });

    it('generates txs for limit mismatches', async () => {
      const config = createStandardConfig();
      const module = createModule(config);

      sandbox
        .stub(module.reader, 'deriveXERC20TokenType')
        .resolves(XERC20Type.Standard);
      sandbox.stub(module.reader, 'readOwner').resolves(OWNER_ADDRESS);
      sandbox.stub(module.reader, 'readProxyAdmin').resolves(undefined);
      sandbox.stub(module.reader, 'readLimits').resolves({
        [WARP_ROUTE_ADDRESS]: {
          type: XERC20Type.Standard,
          mint: '999999999999999999',
          burn: '500000000000000000',
        },
        [EXTRA_BRIDGE_ADDRESS]: {
          type: XERC20Type.Standard,
          mint: '2000000000000000000',
          burn: '1000000000000000000',
        },
      });

      const txs = await module.update(config);

      expect(txs.length).to.be.greaterThan(0);
    });

    it('does not emit ownership transfer txs by default', async () => {
      const config: XERC20ModuleConfig = {
        ...createStandardConfig(),
        owner: NEW_OWNER_ADDRESS,
        proxyAdmin: { owner: NEW_OWNER_ADDRESS },
      };
      const module = createModule(config);

      sandbox
        .stub(module.reader, 'deriveXERC20TokenType')
        .resolves(XERC20Type.Standard);
      sandbox.stub(module.reader, 'readLimits').resolves(config.limits);
      sandbox.stub(module.reader, 'readOwner').resolves(OWNER_ADDRESS);
      sandbox.stub(module.reader, 'readProxyAdmin').resolves({
        address: PROXY_ADMIN_ADDRESS,
        owner: OWNER_ADDRESS,
      });

      const txs = await module.update(config);

      // No limit drift and ownership gated off, so nothing should be emitted.
      expect(txs).to.have.lengthOf(0);
    });

    it('appends a token ownership transfer tx when expected owner differs', async () => {
      const config: XERC20ModuleConfig = {
        ...createStandardConfig(),
        owner: NEW_OWNER_ADDRESS,
      };
      const module = createModule(config);

      sandbox
        .stub(module.reader, 'deriveXERC20TokenType')
        .resolves(XERC20Type.Standard);
      sandbox.stub(module.reader, 'readLimits').resolves(config.limits);
      sandbox.stub(module.reader, 'readOwner').resolves(OWNER_ADDRESS);
      sandbox.stub(module.reader, 'readProxyAdmin').resolves(undefined);

      const txs = await module.update(config, { includeOwnership: true });

      expect(txs).to.have.lengthOf(1);
      expect(txs[0].to).to.equal(XERC20_ADDRESS);
      expect(txs[0].annotation).to.include('Transferring ownership');
      expect(
        eqAddress(
          decodeTransferOwnershipTarget(txs[0].data),
          NEW_OWNER_ADDRESS,
        ),
      ).to.equal(true);
    });

    it('appends a ProxyAdmin ownership transfer tx when expected proxyAdmin owner differs', async () => {
      const config: XERC20ModuleConfig = {
        ...createStandardConfig(),
        proxyAdmin: { owner: NEW_OWNER_ADDRESS },
      };
      const module = createModule(config);

      sandbox
        .stub(module.reader, 'deriveXERC20TokenType')
        .resolves(XERC20Type.Standard);
      sandbox.stub(module.reader, 'readLimits').resolves(config.limits);
      sandbox.stub(module.reader, 'readOwner').resolves(OWNER_ADDRESS);
      sandbox.stub(module.reader, 'readProxyAdmin').resolves({
        address: PROXY_ADMIN_ADDRESS,
        owner: OWNER_ADDRESS,
      });

      const txs = await module.update(config, { includeOwnership: true });

      expect(txs).to.have.lengthOf(1);
      expect(txs[0].to).to.equal(PROXY_ADMIN_ADDRESS);
      expect(txs[0].annotation).to.include('Transferring ownership');
      expect(
        eqAddress(
          decodeTransferOwnershipTarget(txs[0].data),
          NEW_OWNER_ADDRESS,
        ),
      ).to.equal(true);
    });

    it('does not emit a ProxyAdmin transfer when the token is unproxied', async () => {
      const config: XERC20ModuleConfig = {
        ...createStandardConfig(),
        proxyAdmin: { owner: NEW_OWNER_ADDRESS },
      };
      const module = createModule(config);

      sandbox
        .stub(module.reader, 'deriveXERC20TokenType')
        .resolves(XERC20Type.Standard);
      sandbox.stub(module.reader, 'readLimits').resolves(config.limits);
      sandbox.stub(module.reader, 'readOwner').resolves(OWNER_ADDRESS);
      // Unproxied token: no on-chain ProxyAdmin to transfer.
      sandbox.stub(module.reader, 'readProxyAdmin').resolves(undefined);

      const txs = await module.update(config, { includeOwnership: true });

      expect(txs).to.have.lengthOf(0);
    });

    it('no-ops ownership transfer when owners already match', async () => {
      const config: XERC20ModuleConfig = {
        ...createStandardConfig(),
        owner: OWNER_ADDRESS,
        proxyAdmin: { owner: OWNER_ADDRESS },
      };
      const module = createModule(config);

      sandbox
        .stub(module.reader, 'deriveXERC20TokenType')
        .resolves(XERC20Type.Standard);
      sandbox.stub(module.reader, 'readLimits').resolves(config.limits);
      sandbox.stub(module.reader, 'readOwner').resolves(OWNER_ADDRESS);
      sandbox.stub(module.reader, 'readProxyAdmin').resolves({
        address: PROXY_ADMIN_ADDRESS,
        owner: OWNER_ADDRESS,
      });

      const txs = await module.update(config, { includeOwnership: true });

      expect(txs).to.have.lengthOf(0);
    });

    it('applies limit updates before ownership transfer', async () => {
      const config: XERC20ModuleConfig = {
        ...createStandardConfig(),
        owner: NEW_OWNER_ADDRESS,
      };
      const module = createModule(config);

      sandbox
        .stub(module.reader, 'deriveXERC20TokenType')
        .resolves(XERC20Type.Standard);
      sandbox.stub(module.reader, 'readLimits').resolves({
        [WARP_ROUTE_ADDRESS]: {
          type: XERC20Type.Standard,
          mint: '999999999999999999',
          burn: '500000000000000000',
        },
        [EXTRA_BRIDGE_ADDRESS]: {
          type: XERC20Type.Standard,
          mint: '2000000000000000000',
          burn: '1000000000000000000',
        },
      });
      sandbox.stub(module.reader, 'readOwner').resolves(OWNER_ADDRESS);
      sandbox.stub(module.reader, 'readProxyAdmin').resolves(undefined);

      const txs = await module.update(config, { includeOwnership: true });

      // Limit update tx(s) come first; the ownership transfer is last.
      const lastTx = txs[txs.length - 1];
      expect(lastTx.to).to.equal(XERC20_ADDRESS);
      expect(
        eqAddress(
          decodeTransferOwnershipTarget(lastTx.data),
          NEW_OWNER_ADDRESS,
        ),
      ).to.equal(true);
      expect(txs.length).to.be.greaterThan(1);
    });
  });

  describe('Aevo XERC20', () => {
    // The txs against the token for the router, as call data: a cap of zero
    // is how a minter is left without a bound.
    const setCap = (cap: bigint) => ({
      to: XERC20_ADDRESS,
      data: `${SET_CAP_SELECTOR}${word(WARP_ROUTE_ADDRESS)}${word(cap)}`,
    });
    const updateAuthority = (authorized: boolean) => ({
      to: XERC20_ADDRESS,
      data: `${UPDATE_AUTHORITY_SELECTOR}${word(WARP_ROUTE_ADDRESS)}${word(authorized ? 1 : 0)}`,
    });

    it('generates setCap then updateAuthority txs against the token, on its chain, for an authorized minter', async () => {
      const limits = aevoRaw('1000');
      const module = createModule(createAevoConfig(limits));

      const txs = await module.generateSetLimitsTxs(WARP_ROUTE_ADDRESS, limits);

      expect(txs.map(({ to, data }) => ({ to, data }))).to.deep.equal([
        setCap(1000n),
        updateAuthority(true),
      ]);
      expect(txs[0].chainId).to.equal(
        multiProvider.getEvmChainId(TestChainName.test1),
      );
    });

    it('adds a bridge the same way it sets its limits', async () => {
      const limits = aevoRaw('1000');
      const module = createModule(createAevoConfig(limits));

      const txs = await module.generateAddBridgeTxs(WARP_ROUTE_ADDRESS, limits);

      expect(txs.map(({ to, data }) => ({ to, data }))).to.deep.equal([
        setCap(1000n),
        updateAuthority(true),
      ]);
    });

    interface UpdateCase {
      name: string;
      expected: AevoXERC20Limits;
      // What the token holds for the router: an unauthorized entry when it holds
      // nothing, which is what the reader reports for it.
      actual: AevoXERC20Limits;
      txs: Array<{ to: string; data: string }>;
    }

    const updateCases: UpdateCase[] = [
      {
        name: 'emits no tx when the authority and cap already match',
        expected: aevoRaw('1000'),
        actual: aevoRaw('1000'),
        txs: [],
      },
      {
        name: 'emits no tx when a minter expected not to be bound is not',
        expected: aevoUnlimited(),
        actual: aevoUnlimited(),
        txs: [],
      },
      {
        name: 'emits no tx when a minter expected not to be authorized is not',
        expected: aevoUnauthorized(),
        actual: aevoUnauthorized(),
        txs: [],
      },
      {
        // What the token kept for a minter that is not authorized is not read,
        // and it is the cap the token applies once the minter is authorized
        // again, so the cap is set whatever it kept.
        name: 'authorizes a minter that is not authorized, setting its cap first',
        expected: aevoRaw('1000'),
        actual: aevoUnauthorized(),
        txs: [setCap(1000n), updateAuthority(true)],
      },
      {
        name: 'authorizes a minter that is not authorized without a bound',
        expected: aevoUnlimited(),
        actual: aevoUnauthorized(),
        txs: [setCap(0n), updateAuthority(true)],
      },
      {
        name: 'changes the cap of an authorized minter, and nothing else',
        expected: aevoRaw('2000'),
        actual: aevoRaw('1000'),
        txs: [setCap(2000n)],
      },
      {
        name: 'binds a minter that was not bound, and nothing else',
        expected: aevoRaw('1000'),
        actual: aevoUnlimited(),
        txs: [setCap(1000n)],
      },
      {
        name: 'unbinds a minter with a cap by setting a cap of zero, and nothing else',
        expected: aevoUnlimited(),
        actual: aevoRaw('1000'),
        txs: [setCap(0n)],
      },
      {
        name: 'revokes an authorized minter, and leaves its cap',
        expected: aevoUnauthorized(),
        actual: aevoRaw('1000'),
        txs: [updateAuthority(false)],
      },
      {
        name: 'revokes a minter that is not bound, and leaves its cap',
        expected: aevoUnauthorized(),
        actual: aevoUnlimited(),
        txs: [updateAuthority(false)],
      },
    ];

    for (const c of updateCases) {
      it(c.name, async () => {
        const config = createAevoConfig(c.expected);
        const module = createModule(config);
        stubChain(module, { [WARP_ROUTE_ADDRESS]: c.actual });

        const txs = await module.update(config);

        expect(txs.map(({ to, data }) => ({ to, data }))).to.deep.equal(c.txs);
      });
    }

    it('rejects an Aevo config for a token that is not Aevo', async () => {
      const config = createAevoConfig(aevoRaw('1000'));
      const module = createModule(config);
      stubChain(module, {}, XERC20Type.Standard);

      await expect(module.update(config)).to.be.rejectedWith(
        'XERC20 type mismatch: expected aevo but on-chain is standard',
      );
    });

    it('rejects a Standard config for an Aevo token', async () => {
      const config = createStandardConfig();
      const module = createModule(config);
      stubChain(module, {});

      await expect(module.update(config)).to.be.rejectedWith(
        'XERC20 type mismatch: expected standard but on-chain is aevo',
      );
    });
  });

  describe('ownership of the token', () => {
    // The reader reports an owner checksummed, a config may write it in any
    // case.
    const CHECKSUMMED_OWNER = PROXY_ADMIN_ADDRESS;

    interface TokenCase {
      name: string;
      type: XERC20Type;
      // Limits the token already holds, so that only its owner can differ.
      config: XERC20ModuleConfig;
      // The tx that hands the token to the owner.
      ownerTx: (owner: Address) => { to: string; data: string };
    }

    const tokenCases: TokenCase[] = [
      {
        name: 'a Standard token',
        type: XERC20Type.Standard,
        config: createStandardConfig(),
        ownerTx: (owner) => ({
          to: XERC20_ADDRESS,
          data: `${TRANSFER_OWNERSHIP_SELECTOR}${word(owner)}`,
        }),
      },
      {
        name: 'a Velodrome token',
        type: XERC20Type.Velo,
        config: createVeloConfig(),
        ownerTx: (owner) => ({
          to: XERC20_ADDRESS,
          data: `${TRANSFER_OWNERSHIP_SELECTOR}${word(owner)}`,
        }),
      },
      {
        // An Aevo token hands over through its own setOwner, which takes effect
        // at once.
        name: 'an Aevo token',
        type: XERC20Type.Aevo,
        config: createAevoConfig(aevoRaw('1000')),
        ownerTx: (owner) => ({
          to: XERC20_ADDRESS,
          data: `${SET_OWNER_SELECTOR}${word(owner)}`,
        }),
      },
    ];

    for (const t of tokenCases) {
      const update = async (
        owner: Address | undefined,
        actualOwner: Address,
        options?: { includeOwnership?: boolean },
      ) => {
        const config: XERC20ModuleConfig = {
          type: t.type,
          limits: t.config.limits,
          owner,
        };
        const module = createModule(config);
        stubChain(module, t.config.limits, t.type, actualOwner);
        const txs = await module.update(config, options);
        return txs.map(({ to, data }) => ({ to, data }));
      };

      it(`hands ${t.name} to the expected owner when it differs`, async () => {
        expect(
          await update(NEW_OWNER_ADDRESS, OWNER_ADDRESS, {
            includeOwnership: true,
          }),
        ).to.deep.equal([t.ownerTx(NEW_OWNER_ADDRESS)]);
      });

      it(`leaves ${t.name} alone when its owner matches in another case`, async () => {
        expect(
          await update(CHECKSUMMED_OWNER.toLowerCase(), CHECKSUMMED_OWNER, {
            includeOwnership: true,
          }),
        ).to.deep.equal([]);
      });

      // The warp apply path reads the owner of the router, not of the token.
      it(`leaves the owner of ${t.name} alone without includeOwnership`, async () => {
        expect(await update(NEW_OWNER_ADDRESS, OWNER_ADDRESS)).to.deep.equal(
          [],
        );
      });

      // Nothing to hand over, and for an Aevo token nothing to refuse either:
      // its setOwner reverts on the zero address.
      it(`leaves ${t.name} alone when its owner and the expected owner are both the zero address`, async () => {
        expect(
          await update(constants.AddressZero, constants.AddressZero, {
            includeOwnership: true,
          }),
        ).to.deep.equal([]);
      });

      it(`leaves the owner of ${t.name} alone when none is expected`, async () => {
        expect(
          await update(undefined, OWNER_ADDRESS, { includeOwnership: true }),
        ).to.deep.equal([]);
      });
    }

    it('hands an Aevo token over after its limits are set', async () => {
      const config: XERC20ModuleConfig = {
        ...createAevoConfig(aevoRaw('1000')),
        owner: NEW_OWNER_ADDRESS,
      };
      const module = createModule(config);
      stubChain(
        module,
        { [WARP_ROUTE_ADDRESS]: aevoRaw('2000') },
        XERC20Type.Aevo,
        OWNER_ADDRESS,
      );

      const txs = await module.update(config, { includeOwnership: true });

      expect(txs.map(({ to, data }) => ({ to, data }))).to.deep.equal([
        {
          to: XERC20_ADDRESS,
          data: `${SET_CAP_SELECTOR}${word(WARP_ROUTE_ADDRESS)}${word(1000n)}`,
        },
        {
          to: XERC20_ADDRESS,
          data: `${SET_OWNER_SELECTOR}${word(NEW_OWNER_ADDRESS)}`,
        },
      ]);
    });

    it('renounces the ownership of a Standard token', async () => {
      const config: XERC20ModuleConfig = {
        ...createStandardConfig(),
        owner: constants.AddressZero,
      };
      const module = createModule(config);
      stubChain(module, config.limits, XERC20Type.Standard);

      const txs = await module.update(config, { includeOwnership: true });

      expect(txs.map(({ to, data }) => ({ to, data }))).to.deep.equal([
        { to: XERC20_ADDRESS, data: RENOUNCE_OWNERSHIP_SELECTOR },
      ]);
    });

    it('refuses to renounce the ownership of an Aevo token, whose setOwner reverts on the zero address', async () => {
      const config: XERC20ModuleConfig = {
        ...createAevoConfig(aevoRaw('1000')),
        owner: constants.AddressZero,
      };
      const module = createModule(config);
      stubChain(module, config.limits);

      await expect(
        module.update(config, { includeOwnership: true }),
      ).to.be.rejectedWith('whose ownership cannot be renounced');
    });
  });

  describe('limits that already match', () => {
    // A limit the token already holds must not be set again, zero included:
    // an apply that converges emits nothing.
    const zeroStandard: StandardXERC20Limits = {
      type: XERC20Type.Standard,
      mint: '0',
      burn: '0',
    };
    const zeroVelo: VeloXERC20Limits = {
      type: XERC20Type.Velo,
      bufferCap: '0',
      rateLimitPerSecond: '0',
    };

    // The txs against the token for the router, as call data.
    const setLimits = (mint: bigint, burn: bigint) => ({
      to: XERC20_ADDRESS,
      data: `${SET_LIMITS_SELECTOR}${word(WARP_ROUTE_ADDRESS)}${word(mint)}${word(burn)}`,
    });
    const setBufferCap = (bufferCap: bigint) => ({
      to: XERC20_ADDRESS,
      data: `${SET_BUFFER_CAP_SELECTOR}${word(WARP_ROUTE_ADDRESS)}${word(bufferCap)}`,
    });
    const setRateLimit = (rateLimit: bigint) => ({
      to: XERC20_ADDRESS,
      data: `${SET_RATE_LIMIT_SELECTOR}${word(WARP_ROUTE_ADDRESS)}${word(rateLimit)}`,
    });

    interface Case {
      name: string;
      type: XERC20Type;
      expected: XERC20ModuleConfig['limits'][string];
      actual: XERC20ModuleConfig['limits'][string];
      txs: Array<{ to: string; data: string }>;
    }

    const cases: Case[] = [
      {
        name: 'emits no tx when a Standard limit expected to be zero is zero',
        type: XERC20Type.Standard,
        expected: zeroStandard,
        actual: zeroStandard,
        txs: [],
      },
      {
        name: 'emits no tx when a Velodrome limit expected to be zero is zero',
        type: XERC20Type.Velo,
        expected: zeroVelo,
        actual: zeroVelo,
        txs: [],
      },
      {
        name: 'still sets a Standard limit that differs from a non zero one',
        type: XERC20Type.Standard,
        expected: { type: XERC20Type.Standard, mint: '2', burn: '2' },
        actual: { type: XERC20Type.Standard, mint: '1', burn: '2' },
        txs: [setLimits(2n, 2n)],
      },
      {
        name: 'still sets a Velodrome limit that differs from a non zero one',
        type: XERC20Type.Velo,
        expected: {
          type: XERC20Type.Velo,
          bufferCap: '2',
          rateLimitPerSecond: '2',
        },
        actual: {
          type: XERC20Type.Velo,
          bufferCap: '1',
          rateLimitPerSecond: '2',
        },
        txs: [setBufferCap(2n), setRateLimit(2n)],
      },
      {
        name: 'still sets a Standard limit the token holds as zero',
        type: XERC20Type.Standard,
        expected: { type: XERC20Type.Standard, mint: '2', burn: '2' },
        actual: zeroStandard,
        txs: [setLimits(2n, 2n)],
      },
      {
        name: 'still zeroes a Standard limit the token holds as non zero',
        type: XERC20Type.Standard,
        expected: zeroStandard,
        actual: { type: XERC20Type.Standard, mint: '1', burn: '2' },
        txs: [setLimits(0n, 0n)],
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const config: XERC20ModuleConfig = {
          type: c.type,
          limits: { [WARP_ROUTE_ADDRESS]: c.expected },
        };
        const module = createModule(config);
        sandbox.stub(module.reader, 'deriveXERC20TokenType').resolves(c.type);
        sandbox.stub(module.reader, 'readOwner').resolves(OWNER_ADDRESS);
        sandbox.stub(module.reader, 'readProxyAdmin').resolves(undefined);
        sandbox.stub(module.reader, 'readOnChainBridges').resolves([]);
        sandbox
          .stub(module.reader, 'readLimits')
          .resolves({ [WARP_ROUTE_ADDRESS]: c.actual });

        const txs = await module.update(config);

        expect(txs.map(({ to, data }) => ({ to, data }))).to.deep.equal(c.txs);
      });
    }
  });

  describe('fromWarpRouteConfig', () => {
    it('creates module from standard warp route config', async () => {
      const warpRouteConfig: XERC20LimitsTokenConfig = {
        type: TokenType.XERC20,
        token: XERC20_ADDRESS,
        xERC20: {
          warpRouteLimits: {
            type: XERC20Type.Standard,
            mint: '1000000000000000000',
            burn: '500000000000000000',
          },
        },
      };

      const { module, config } = await EvmXERC20Module.fromWarpRouteConfig(
        multiProvider,
        TestChainName.test1,
        warpRouteConfig,
        WARP_ROUTE_ADDRESS,
      );

      expect(module).to.be.instanceOf(EvmXERC20Module);
      expect(config.type).to.equal(XERC20Type.Standard);
      expect(config.limits[WARP_ROUTE_ADDRESS]).to.deep.equal({
        type: XERC20Type.Standard,
        mint: '1000000000000000000',
        burn: '500000000000000000',
      });
    });

    it('creates module from velodrome warp route config', async () => {
      const warpRouteConfig: XERC20LimitsTokenConfig = {
        type: TokenType.XERC20,
        token: XERC20_ADDRESS,
        xERC20: {
          warpRouteLimits: {
            type: XERC20Type.Velo,
            bufferCap: '1000000000000000000',
            rateLimitPerSecond: '100000000000000000',
          },
        },
      };

      const { module, config } = await EvmXERC20Module.fromWarpRouteConfig(
        multiProvider,
        TestChainName.test1,
        warpRouteConfig,
        WARP_ROUTE_ADDRESS,
      );

      expect(module).to.be.instanceOf(EvmXERC20Module);
      expect(config.type).to.equal(XERC20Type.Velo);
      expect(config.limits[WARP_ROUTE_ADDRESS]).to.deep.equal({
        type: XERC20Type.Velo,
        bufferCap: '1000000000000000000',
        rateLimitPerSecond: '100000000000000000',
      });
    });

    it('includes extra bridges in config', async () => {
      const warpRouteConfig: XERC20LimitsTokenConfig = {
        type: TokenType.XERC20,
        token: XERC20_ADDRESS,
        xERC20: {
          warpRouteLimits: {
            type: XERC20Type.Standard,
            mint: '1000000000000000000',
            burn: '500000000000000000',
          },
          extraBridges: [
            {
              lockbox: EXTRA_BRIDGE_ADDRESS,
              limits: {
                type: XERC20Type.Standard,
                mint: '2000000000000000000',
                burn: '1000000000000000000',
              },
            },
          ],
        },
      };

      const { config } = await EvmXERC20Module.fromWarpRouteConfig(
        multiProvider,
        TestChainName.test1,
        warpRouteConfig,
        WARP_ROUTE_ADDRESS,
      );

      expect(Object.keys(config.limits)).to.have.lengthOf(2);
      expect(config.limits[EXTRA_BRIDGE_ADDRESS]).to.deep.equal({
        type: XERC20Type.Standard,
        mint: '2000000000000000000',
        burn: '1000000000000000000',
      });
    });

    it('resolves xERC20 address from lockbox config', async () => {
      const xerc20Stub = sandbox.stub().resolves(XERC20_FROM_LOCKBOX);
      const connectStub = sandbox
        .stub(IXERC20Lockbox__factory, 'connect')
        .returns({ callStatic: { XERC20: xerc20Stub } } as any);

      const warpRouteConfig: XERC20LimitsTokenConfig = {
        type: TokenType.XERC20Lockbox,
        token: LOCKBOX_ADDRESS,
        xERC20: {
          warpRouteLimits: {
            type: XERC20Type.Standard,
            mint: '1',
            burn: '2',
          },
        },
      };

      const { module, config } = await EvmXERC20Module.fromWarpRouteConfig(
        multiProvider,
        TestChainName.test1,
        warpRouteConfig,
        WARP_ROUTE_ADDRESS,
      );

      expect(
        connectStub.calledWith(
          LOCKBOX_ADDRESS,
          multiProvider.getProvider(TestChainName.test1),
        ),
      ).to.equal(true);
      expect(xerc20Stub.calledOnce).to.equal(true);
      expect(module.serialize().xERC20).to.equal(XERC20_FROM_LOCKBOX);
      expect(config.limits[WARP_ROUTE_ADDRESS]).to.deep.equal({
        type: XERC20Type.Standard,
        mint: '1',
        burn: '2',
      });
    });

    it('populates expected owner and proxyAdmin owner from config.owner', async () => {
      const warpRouteConfig: XERC20LimitsTokenConfig & Partial<OwnableConfig> =
        {
          type: TokenType.XERC20,
          token: XERC20_ADDRESS,
          owner: OWNER_ADDRESS,
          xERC20: {
            warpRouteLimits: {
              type: XERC20Type.Velo,
              bufferCap: '1000000000000000000',
              rateLimitPerSecond: '100000000000000000',
            },
          },
        };

      const { config } = await EvmXERC20Module.fromWarpRouteConfig(
        multiProvider,
        TestChainName.test1,
        warpRouteConfig,
        WARP_ROUTE_ADDRESS,
      );

      expect(config.owner).to.equal(OWNER_ADDRESS);
      expect(config.proxyAdmin).to.deep.equal({ owner: OWNER_ADDRESS });
    });

    it('declares the limits of an Aevo warp route', async () => {
      const warpRouteConfig: XERC20LimitsTokenConfig = {
        type: TokenType.XERC20,
        token: XERC20_ADDRESS,
        xERC20: { warpRouteLimits: aevoRaw('1000') },
      };

      const { config } = await EvmXERC20Module.fromWarpRouteConfig(
        multiProvider,
        TestChainName.test1,
        warpRouteConfig,
        WARP_ROUTE_ADDRESS,
      );

      expect(config.type).to.equal(XERC20Type.Aevo);
      expect(config.limits).to.deep.equal({
        [WARP_ROUTE_ADDRESS]: aevoRaw('1000'),
      });
    });

    it('expects the owner of an Aevo token as it does of any other', async () => {
      const warpRouteConfig: XERC20LimitsTokenConfig & Partial<OwnableConfig> =
        {
          type: TokenType.XERC20,
          token: XERC20_ADDRESS,
          owner: OWNER_ADDRESS,
          xERC20: { warpRouteLimits: aevoRaw('1000') },
        };

      const { config } = await EvmXERC20Module.fromWarpRouteConfig(
        multiProvider,
        TestChainName.test1,
        warpRouteConfig,
        WARP_ROUTE_ADDRESS,
      );

      expect(config.owner).to.equal(OWNER_ADDRESS);
      expect(config.proxyAdmin).to.deep.equal({ owner: OWNER_ADDRESS });
    });

    it('derives an Aevo token, and manages none of its limits, when none are declared', async () => {
      sandbox
        .stub(EvmXERC20Reader.prototype, 'deriveXERC20TokenType')
        .resolves(XERC20Type.Aevo);
      const warpRouteConfig: XERC20LimitsTokenConfig = {
        type: TokenType.XERC20,
        token: XERC20_ADDRESS,
      };

      const { module, config } = await EvmXERC20Module.fromWarpRouteConfig(
        multiProvider,
        TestChainName.test1,
        warpRouteConfig,
        WARP_ROUTE_ADDRESS,
      );
      sandbox.stub(module.reader, 'readOwner').resolves(OWNER_ADDRESS);
      sandbox.stub(module.reader, 'readProxyAdmin').resolves(undefined);

      expect(config).to.deep.equal({ type: XERC20Type.Aevo, limits: {} });
      expect(await module.update(config)).to.have.lengthOf(0);
    });

    interface PartialLimitCase {
      name: string;
      limits: XERC20LimitsTokenConfig['xERC20'];
    }

    // A Standard or Velodrome entry that leaves out either of its limits is not
    // managed: the limit it leaves out is neither read nor set.
    const partialLimitCases: PartialLimitCase[] = [
      {
        name: 'a Standard entry that leaves out its burn limit',
        limits: { warpRouteLimits: { type: XERC20Type.Standard, mint: '1' } },
      },
      {
        name: 'a Standard entry that leaves out its mint limit',
        limits: { warpRouteLimits: { type: XERC20Type.Standard, burn: '1' } },
      },
      {
        name: 'a Velodrome entry that leaves out its rate limit',
        limits: {
          warpRouteLimits: { type: XERC20Type.Velo, bufferCap: '1' },
        },
      },
      {
        name: 'a Velodrome entry that leaves out its buffer cap',
        limits: {
          warpRouteLimits: {
            type: XERC20Type.Velo,
            rateLimitPerSecond: '1',
          },
        },
      },
      {
        name: 'an extra bridge entry that leaves out a limit',
        limits: {
          warpRouteLimits: { type: XERC20Type.Standard },
          extraBridges: [
            {
              lockbox: EXTRA_BRIDGE_ADDRESS,
              limits: { type: XERC20Type.Velo, bufferCap: '1' },
            },
          ],
        },
      },
    ];

    for (const c of partialLimitCases) {
      it(`manages no limit for ${c.name}`, async () => {
        const warpRouteConfig: XERC20LimitsTokenConfig = {
          type: TokenType.XERC20,
          token: XERC20_ADDRESS,
          xERC20: c.limits,
        };

        const { config } = await EvmXERC20Module.fromWarpRouteConfig(
          multiProvider,
          TestChainName.test1,
          warpRouteConfig,
          WARP_ROUTE_ADDRESS,
        );

        expect(config.limits).to.deep.equal({});
      });
    }

    it('derives type from chain when limits missing', async () => {
      const typeStub = sandbox
        .stub(EvmXERC20Reader.prototype, 'deriveXERC20TokenType')
        .resolves(XERC20Type.Velo);

      const warpRouteConfig: XERC20LimitsTokenConfig = {
        type: TokenType.XERC20,
        token: XERC20_ADDRESS,
      };

      const { config } = await EvmXERC20Module.fromWarpRouteConfig(
        multiProvider,
        TestChainName.test1,
        warpRouteConfig,
        WARP_ROUTE_ADDRESS,
      );

      expect(typeStub.calledOnce).to.equal(true);
      expect(config.type).to.equal(XERC20Type.Velo);
    });
  });
});
