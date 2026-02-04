import { expect } from 'chai';
import sinon from 'sinon';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmXERC20Module, XERC20ModuleConfig } from './EvmXERC20Module.js';
import {
  EvmXERC20Reader,
  StandardXERC20Limits,
  VeloXERC20Limits,
} from './EvmXERC20Reader.js';
import { TokenType } from './config.js';
import { XERC20Type } from './types.js';

const XERC20_ADDRESS = '0x1111111111111111111111111111111111111111';
const WARP_ROUTE_ADDRESS = '0x5555555555555555555555555555555555555555';
const BRIDGE_ADDRESS_1 = '0x2222222222222222222222222222222222222222';
const EXTRA_BRIDGE_ADDRESS = '0x4444444444444444444444444444444444444444';

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
  });

  describe('fromWarpRouteConfig', () => {
    it('creates module from standard warp route config', async () => {
      const warpRouteConfig = {
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
      const warpRouteConfig = {
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
      const warpRouteConfig = {
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
  });
});
