import { expect } from 'chai';
import sinon from 'sinon';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { WarpCoreConfig } from '../warp/types.js';

import {
  StandardXERC20Limits,
  VelodromeXERC20Limits,
  XERC20DriftResult,
  XERC20WarpModule,
} from './XERC20WarpModule.js';
import { TokenType } from './config.js';
import { WarpRouteDeployConfig, XERC20Type } from './types.js';

const XERC20_ADDRESS = '0x1111111111111111111111111111111111111111';
const WARP_ROUTE_ADDRESS = '0x5555555555555555555555555555555555555555';
const BRIDGE_ADDRESS_1 = '0x2222222222222222222222222222222222222222';
const BRIDGE_ADDRESS_2 = '0x3333333333333333333333333333333333333333';
const EXTRA_BRIDGE_ADDRESS = '0x4444444444444444444444444444444444444444';

describe('XERC20WarpModule', () => {
  let multiProvider: MultiProvider;
  let module: XERC20WarpModule;
  let sandbox: sinon.SinonSandbox;

  const createWarpCoreConfig = (): WarpCoreConfig =>
    ({
      tokens: [
        {
          chainName: TestChainName.test1,
          addressOrDenom: WARP_ROUTE_ADDRESS,
        },
      ],
    }) as WarpCoreConfig;

  const createWarpConfig = (
    xerc20Type: 'standard' | 'velodrome',
  ): WarpRouteDeployConfig => {
    const baseConfig = {
      [TestChainName.test1]: {
        type: TokenType.XERC20,
        token: XERC20_ADDRESS,
        owner: '0x0000000000000000000000000000000000000001',
        mailbox: '0x0000000000000000000000000000000000000002',
        interchainSecurityModule: '0x0000000000000000000000000000000000000003',
        interchainGasPaymaster: '0x0000000000000000000000000000000000000004',
      },
    };

    if (xerc20Type === 'standard') {
      return {
        ...baseConfig,
        [TestChainName.test1]: {
          ...baseConfig[TestChainName.test1],
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
        },
      };
    } else {
      return {
        ...baseConfig,
        [TestChainName.test1]: {
          ...baseConfig[TestChainName.test1],
          xERC20: {
            warpRouteLimits: {
              type: XERC20Type.Velo,
              bufferCap: '1000000000000000000',
              rateLimitPerSecond: '100000000000000000',
            },
            extraBridges: [
              {
                lockbox: EXTRA_BRIDGE_ADDRESS,
                limits: {
                  type: XERC20Type.Velo,
                  bufferCap: '2000000000000000000',
                  rateLimitPerSecond: '200000000000000000',
                },
              },
            ],
          },
        },
      };
    }
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('generateSetLimitsTxs', () => {
    it('generates setLimits tx for Standard XERC20', async () => {
      const config = createWarpConfig('standard');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      sandbox.stub(module, 'detectType').resolves('standard');
      sandbox.stub(module as any, 'getXERC20Address').resolves(XERC20_ADDRESS);

      const limits: StandardXERC20Limits = {
        type: 'standard',
        mint: '1000000000000000000',
        burn: '500000000000000000',
      };

      const txs = await module.generateSetLimitsTxs(
        TestChainName.test1,
        BRIDGE_ADDRESS_1,
        limits,
      );

      expect(txs).to.have.lengthOf(1);
      expect(txs[0].annotation).to.include('XERC20 limit update');
      expect(txs[0].chainId).to.equal(
        multiProvider.getEvmChainId(TestChainName.test1),
      );
    });

    it('generates setBufferCap and setRateLimitPerSecond txs for Velodrome XERC20', async () => {
      const config = createWarpConfig('velodrome');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      sandbox.stub(module, 'detectType').resolves('velodrome');
      sandbox.stub(module as any, 'getXERC20Address').resolves(XERC20_ADDRESS);

      const limits: VelodromeXERC20Limits = {
        type: 'velodrome',
        bufferCap: '1000000000000000000',
        rateLimitPerSecond: '100000000000000000',
      };

      const txs = await module.generateSetLimitsTxs(
        TestChainName.test1,
        BRIDGE_ADDRESS_1,
        limits,
      );

      expect(txs).to.have.lengthOf(2);
      expect(txs[0].annotation).to.include('XERC20 limit update');
      expect(txs[1].annotation).to.include('XERC20 limit update');
    });
  });

  describe('generateAddBridgeTxs', () => {
    it('delegates to generateSetLimitsTxs for Standard XERC20', async () => {
      const config = createWarpConfig('standard');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      sandbox.stub(module, 'detectType').resolves('standard');
      sandbox.stub(module as any, 'getXERC20Address').resolves(XERC20_ADDRESS);

      const limits: StandardXERC20Limits = {
        type: 'standard',
        mint: '1000000000000000000',
        burn: '500000000000000000',
      };

      const txs = await module.generateAddBridgeTxs(
        TestChainName.test1,
        BRIDGE_ADDRESS_1,
        limits,
      );

      expect(txs).to.have.lengthOf(1);
    });

    it('generates addBridge tx for Velodrome XERC20', async () => {
      const config = createWarpConfig('velodrome');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      sandbox.stub(module, 'detectType').resolves('velodrome');
      sandbox.stub(module as any, 'getXERC20Address').resolves(XERC20_ADDRESS);

      const limits: VelodromeXERC20Limits = {
        type: 'velodrome',
        bufferCap: '1000000000000000000',
        rateLimitPerSecond: '100000000000000000',
      };

      const txs = await module.generateAddBridgeTxs(
        TestChainName.test1,
        BRIDGE_ADDRESS_1,
        limits,
      );

      expect(txs).to.have.lengthOf(1);
      expect(txs[0].annotation).to.include('XERC20 limit update');
    });
  });

  describe('generateRemoveBridgeTxs', () => {
    it('generates removeBridge tx for Velodrome XERC20', async () => {
      const config = createWarpConfig('velodrome');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      sandbox.stub(module, 'detectType').resolves('velodrome');
      sandbox.stub(module as any, 'getXERC20Address').resolves(XERC20_ADDRESS);

      const txs = await module.generateRemoveBridgeTxs(
        TestChainName.test1,
        BRIDGE_ADDRESS_1,
      );

      expect(txs).to.have.lengthOf(1);
      expect(txs[0].annotation).to.include('XERC20 limit update');
    });

    it('throws for Standard XERC20', async () => {
      const config = createWarpConfig('standard');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      sandbox.stub(module, 'detectType').resolves('standard');
      sandbox.stub(module as any, 'getXERC20Address').resolves(XERC20_ADDRESS);

      try {
        await module.generateRemoveBridgeTxs(
          TestChainName.test1,
          BRIDGE_ADDRESS_1,
        );
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('removeBridge is only supported');
        expect(error.message).to.include('Velodrome');
      }
    });
  });

  describe('detectDrift', () => {
    it('detects missing bridges', async () => {
      const config = createWarpConfig('standard');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      sandbox.stub(module, 'detectType').resolves('standard');
      sandbox.stub(module as any, 'getXERC20Address').resolves(XERC20_ADDRESS);

      sandbox.stub(module, 'readLimits').resolves({
        [WARP_ROUTE_ADDRESS]: {
          type: 'standard',
          mint: '0',
          burn: '0',
        },
      });

      const drift = await module.detectDrift(TestChainName.test1);

      expect(drift.chain).to.equal(TestChainName.test1);
      expect(drift.xERC20Address).to.equal(XERC20_ADDRESS);
      expect(drift.xerc20Type).to.equal('standard');
      expect(drift.missingBridges).to.include(WARP_ROUTE_ADDRESS);
    });

    it('detects missing bridges', async () => {
      const config = createWarpConfig('standard');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      sandbox.stub(module, 'detectType').resolves('standard');
      sandbox.stub(module as any, 'getXERC20Address').resolves(XERC20_ADDRESS);

      sandbox.stub(module, 'readLimits').resolves({
        [WARP_ROUTE_ADDRESS]: {
          type: 'standard',
          mint: '0',
          burn: '0',
        },
      });

      const drift = await module.detectDrift(TestChainName.test1);

      expect(drift.chain).to.equal(TestChainName.test1);
      expect(drift.xERC20Address).to.equal(XERC20_ADDRESS);
      expect(drift.xerc20Type).to.equal('standard');
      expect(drift.missingBridges).to.include(WARP_ROUTE_ADDRESS);
    });

    it('detects limit mismatches', async () => {
      const config = createWarpConfig('standard');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      sandbox.stub(module, 'detectType').resolves('standard');
      sandbox.stub(module as any, 'getXERC20Address').resolves(XERC20_ADDRESS);

      sandbox.stub(module, 'readLimits').resolves({
        [WARP_ROUTE_ADDRESS]: {
          type: 'standard',
          mint: '500000000000000000',
          burn: '250000000000000000',
        },
      });

      const drift = await module.detectDrift(TestChainName.test1);

      expect(drift.limitMismatches).to.have.lengthOf(1);
      expect(drift.limitMismatches[0].bridge).to.equal(WARP_ROUTE_ADDRESS);
      expect(drift.limitMismatches[0].expected.type).to.equal('standard');
      expect(drift.limitMismatches[0].actual.type).to.equal('standard');
    });

    it('detects extra bridges for Velodrome XERC20', async () => {
      const config = createWarpConfig('velodrome');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      sandbox.stub(module, 'detectType').resolves('velodrome');
      sandbox.stub(module as any, 'getXERC20Address').resolves(XERC20_ADDRESS);

      sandbox.stub(module, 'readLimits').resolves({
        [WARP_ROUTE_ADDRESS]: {
          type: 'velodrome',
          bufferCap: '1000000000000000000',
          rateLimitPerSecond: '100000000000000000',
        },
        [EXTRA_BRIDGE_ADDRESS]: {
          type: 'velodrome',
          bufferCap: '2000000000000000000',
          rateLimitPerSecond: '200000000000000000',
        },
      });

      sandbox
        .stub(module, 'readOnChainBridges')
        .resolves([
          WARP_ROUTE_ADDRESS,
          EXTRA_BRIDGE_ADDRESS,
          BRIDGE_ADDRESS_1,
          BRIDGE_ADDRESS_2,
        ]);

      const drift = await module.detectDrift(TestChainName.test1);

      expect(drift.xerc20Type).to.equal('velodrome');
      expect(drift.extraBridges).to.have.lengthOf(2);
      expect(drift.extraBridges).to.include(BRIDGE_ADDRESS_1);
      expect(drift.extraBridges).to.include(BRIDGE_ADDRESS_2);
    });

    it('does not detect extra bridges for Standard XERC20', async () => {
      const config = createWarpConfig('standard');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      sandbox.stub(module, 'detectType').resolves('standard');
      sandbox.stub(module as any, 'getXERC20Address').resolves(XERC20_ADDRESS);

      sandbox.stub(module, 'readLimits').resolves({
        [WARP_ROUTE_ADDRESS]: {
          type: 'standard',
          mint: '1000000000000000000',
          burn: '500000000000000000',
        },
        [EXTRA_BRIDGE_ADDRESS]: {
          type: 'standard',
          mint: '2000000000000000000',
          burn: '1000000000000000000',
        },
      });

      const drift = await module.detectDrift(TestChainName.test1);

      expect(drift.extraBridges).to.have.lengthOf(0);
    });
  });

  describe('generateDriftCorrectionTxs', () => {
    it('generates txs to remove extra bridges for Velodrome', async () => {
      const config = createWarpConfig('velodrome');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      sandbox.stub(module, 'detectType').resolves('velodrome');
      sandbox.stub(module as any, 'getXERC20Address').resolves(XERC20_ADDRESS);

      const drift: XERC20DriftResult = {
        chain: TestChainName.test1,
        xERC20Address: XERC20_ADDRESS,
        xerc20Type: 'velodrome',
        missingBridges: [],
        extraBridges: [BRIDGE_ADDRESS_2],
        limitMismatches: [],
      };

      const txs = await module.generateDriftCorrectionTxs(drift);

      expect(txs.length).to.be.greaterThan(0);
    });

    it('handles empty drift result', async () => {
      const config = createWarpConfig('standard');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      const drift: XERC20DriftResult = {
        chain: TestChainName.test1,
        xERC20Address: XERC20_ADDRESS,
        xerc20Type: 'standard',
        missingBridges: [],
        extraBridges: [],
        limitMismatches: [],
      };

      const txs = await module.generateDriftCorrectionTxs(drift);

      expect(txs).to.be.an('array');
      expect(txs).to.have.lengthOf(0);
    });
  });

  describe('getXERC20Address', () => {
    it('returns token address for XERC20 type', async () => {
      const config = createWarpConfig('standard');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      const address = await (module as any).getXERC20Address(
        TestChainName.test1,
      );

      expect(address).to.equal(XERC20_ADDRESS);
    });

    it('throws for non-XERC20 chain', async () => {
      const config = createWarpConfig('standard');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      try {
        await (module as any).getXERC20Address(TestChainName.test2);
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('not an XERC20 config');
      }
    });
  });

  describe('limitsMatch', () => {
    it('returns true for matching Standard limits', async () => {
      const config = createWarpConfig('standard');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      const a: StandardXERC20Limits = {
        type: 'standard',
        mint: '1000',
        burn: '500',
      };
      const b: StandardXERC20Limits = {
        type: 'standard',
        mint: '1000',
        burn: '500',
      };

      const match = (module as any).limitsMatch(a, b);

      expect(match).to.be.true;
    });

    it('returns false for mismatched Standard limits', async () => {
      const config = createWarpConfig('standard');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      const a: StandardXERC20Limits = {
        type: 'standard',
        mint: '1000',
        burn: '500',
      };
      const b: StandardXERC20Limits = {
        type: 'standard',
        mint: '2000',
        burn: '500',
      };

      const match = (module as any).limitsMatch(a, b);

      expect(match).to.be.false;
    });

    it('returns true for matching Velodrome limits', async () => {
      const config = createWarpConfig('velodrome');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      const a: VelodromeXERC20Limits = {
        type: 'velodrome',
        bufferCap: '1000',
        rateLimitPerSecond: '100',
      };
      const b: VelodromeXERC20Limits = {
        type: 'velodrome',
        bufferCap: '1000',
        rateLimitPerSecond: '100',
      };

      const match = (module as any).limitsMatch(a, b);

      expect(match).to.be.true;
    });

    it('returns false for type mismatch', async () => {
      const config = createWarpConfig('standard');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      const a: StandardXERC20Limits = {
        type: 'standard',
        mint: '1000',
        burn: '500',
      };
      const b: VelodromeXERC20Limits = {
        type: 'velodrome',
        bufferCap: '1000',
        rateLimitPerSecond: '100',
      };

      const match = (module as any).limitsMatch(a, b);

      expect(match).to.be.false;
    });
  });

  describe('limitsAreZero', () => {
    it('returns true for zero Standard limits', async () => {
      const config = createWarpConfig('standard');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      const limits: StandardXERC20Limits = {
        type: 'standard',
        mint: '0',
        burn: '0',
      };

      const isZero = (module as any).limitsAreZero(limits);

      expect(isZero).to.be.true;
    });

    it('returns false for non-zero Standard limits', async () => {
      const config = createWarpConfig('standard');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      const limits: StandardXERC20Limits = {
        type: 'standard',
        mint: '1000',
        burn: '0',
      };

      const isZero = (module as any).limitsAreZero(limits);

      expect(isZero).to.be.false;
    });

    it('returns true for zero Velodrome limits', async () => {
      const config = createWarpConfig('velodrome');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      const limits: VelodromeXERC20Limits = {
        type: 'velodrome',
        bufferCap: '0',
        rateLimitPerSecond: '0',
      };

      const isZero = (module as any).limitsAreZero(limits);

      expect(isZero).to.be.true;
    });
  });

  describe('toStandardLimits', () => {
    it('converts xERC20Limits to StandardXERC20Limits', async () => {
      const config = createWarpConfig('standard');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      const xERC20Limits = {
        mint: BigInt('1000000000000000000'),
        burn: BigInt('500000000000000000'),
      };

      const result = (module as any).toStandardLimits(xERC20Limits);

      expect(result).to.deep.equal({
        type: 'standard',
        mint: '1000000000000000000',
        burn: '500000000000000000',
      });
    });
  });

  describe('toVelodromeLimits', () => {
    it('converts RateLimitMidPoint to VelodromeXERC20Limits', async () => {
      const config = createWarpConfig('velodrome');
      module = new XERC20WarpModule(
        multiProvider,
        config,
        createWarpCoreConfig(),
      );

      const rateLimits = {
        bufferCap: BigInt('1000000000000000000'),
        rateLimitPerSecond: BigInt('100000000000000000'),
        lastBufferUsedTime: 0,
        bufferStored: BigInt('0'),
        midPoint: BigInt('500000000000000000'),
      };

      const result = (module as any).toVelodromeLimits(rateLimits);

      expect(result).to.deep.equal({
        type: 'velodrome',
        bufferCap: '1000000000000000000',
        rateLimitPerSecond: '100000000000000000',
      });
    });
  });
});
