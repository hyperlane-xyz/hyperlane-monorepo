import { expect } from 'chai';

import {
  TokenStandard,
  TokenType,
  TxSubmitterType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';

import { type CommandContext } from '../../types.js';
import { type ExtendedSubmissionStrategy } from '../../../submitters/types.js';

import { getSubmitterChains, resolveChains } from './chainResolver.js';

type Submitter = ExtendedSubmissionStrategy['submitter'];

describe('getSubmitterChains', () => {
  it('should return chain for a JSON_RPC submitter', () => {
    const submitter: Submitter = {
      type: TxSubmitterType.JSON_RPC,
      chain: 'ethereum',
    };
    expect(getSubmitterChains(submitter)).to.deep.equal(['ethereum']);
  });

  it('should return chain for a Gnosis Safe submitter', () => {
    const submitter: Submitter = {
      type: TxSubmitterType.GNOSIS_SAFE,
      chain: 'arbitrum',
      safeAddress: '0x0000000000000000000000000000000000000001',
    };
    expect(getSubmitterChains(submitter)).to.deep.equal(['arbitrum']);
  });

  it('should return origin, destination, and internal submitter chains for an ICA submitter', () => {
    const submitter: Submitter = {
      type: TxSubmitterType.INTERCHAIN_ACCOUNT,
      chain: 'ethereum',
      owner: '0x0000000000000000000000000000000000000001',
      destinationChain: 'arbitrum',
      internalSubmitter: {
        type: TxSubmitterType.JSON_RPC,
        chain: 'ethereum',
      },
    };
    expect(getSubmitterChains(submitter)).to.deep.equal([
      'ethereum',
      'arbitrum',
      'ethereum',
    ]);
  });

  it('should return chain and proposer submitter chains for a Timelock submitter', () => {
    const submitter: Submitter = {
      type: TxSubmitterType.TIMELOCK_CONTROLLER,
      chain: 'optimism',
      timelockAddress: '0x0000000000000000000000000000000000000002',
      proposerSubmitter: {
        type: TxSubmitterType.JSON_RPC,
        chain: 'optimism',
      },
    };
    const result = getSubmitterChains(submitter);
    expect(result).to.deep.equal(['optimism', 'optimism']);
  });

  it('should handle nested ICA with Gnosis Safe internal submitter', () => {
    const submitter: Submitter = {
      type: TxSubmitterType.INTERCHAIN_ACCOUNT,
      chain: 'ethereum',
      owner: '0x0000000000000000000000000000000000000001',
      destinationChain: 'arbitrum',
      internalSubmitter: {
        type: TxSubmitterType.GNOSIS_SAFE,
        chain: 'ethereum',
        safeAddress: '0x0000000000000000000000000000000000000003',
      },
    };
    expect(getSubmitterChains(submitter)).to.deep.equal([
      'ethereum',
      'arbitrum',
      'ethereum',
    ]);
  });
});

describe('resolveChains — STATUS command', () => {
  const statusArgv = (
    overrides: Partial<Parameters<typeof resolveChains>[0]> = {},
  ): Parameters<typeof resolveChains>[0] => ({
    _: ['status'],
    context: {} as CommandContext,
    ...overrides,
  });

  it('returns only origin when origin provided', async () => {
    const result = await resolveChains(statusArgv({ origin: 'bsc' }));
    expect(result).to.deep.equal(['bsc']);
  });

  it('returns empty array when origin not provided', async () => {
    const result = await resolveChains(statusArgv());
    expect(result).to.deep.equal([]);
  });
});

describe('resolveChains — warp --skip-chains', () => {
  const routeId = 'TST/healthy-down';
  const owner = '0x1111111111111111111111111111111111111111';
  const mailbox = '0x2222222222222222222222222222222222222222';
  const deployConfig = {
    healthy: {
      type: TokenType.synthetic,
      owner,
      mailbox,
      name: 'Test',
      symbol: 'TST',
      decimals: 18,
    },
    down: {
      type: TokenType.synthetic,
      owner,
      mailbox,
      name: 'Test',
      symbol: 'TST',
      decimals: 18,
    },
  };
  const coreConfig = {
    tokens: [
      {
        chainName: 'healthy',
        standard: TokenStandard.EvmHypSynthetic,
        decimals: 18,
        symbol: 'TST',
        name: 'Test',
        addressOrDenom: '0x3333333333333333333333333333333333333333',
      },
      {
        chainName: 'down',
        standard: TokenStandard.EvmHypSynthetic,
        decimals: 18,
        symbol: 'TST',
        name: 'Test',
        addressOrDenom: '0x4444444444444444444444444444444444444444',
      },
    ],
  };

  function warpArgv(command: 'read' | 'deploy' | 'apply' | 'check') {
    let warpDeployConfig: WarpRouteDeployConfig | null = deployConfig;
    let warpCoreConfig: WarpCoreConfig = coreConfig;
    const registry = {
      listRegistryContent: async () => ({
        deployments: {
          warpDeployConfig: { [routeId]: deployConfig },
          warpRoutes: { [routeId]: coreConfig },
        },
      }),
      getWarpDeployConfig: async () => warpDeployConfig,
      getWarpRoute: async () => warpCoreConfig,
    };
    const argv: Parameters<typeof resolveChains>[0] = {
      _: ['warp', command],
      warpRouteId: routeId,
      skipChains: ['down'],
      context: { registry } as unknown as CommandContext,
    };
    return {
      argv,
      setWarpDeployConfig: (config: WarpRouteDeployConfig | null) => {
        warpDeployConfig = config;
      },
      setWarpCoreConfig: (config: WarpCoreConfig) => {
        warpCoreConfig = config;
      },
    };
  }

  it('filters a down chain before warp deploy context setup', async () => {
    const { argv } = warpArgv('deploy');
    expect(await resolveChains(argv)).to.deep.equal(['healthy']);
    expect(Object.keys(argv.context.warpDeployConfig!)).to.deep.equal([
      'healthy',
    ]);
    expect(Object.keys(argv.context.referenceWarpDeployConfig!)).to.deep.equal([
      'healthy',
      'down',
    ]);
  });

  it('filters a down chain from warp read inputs', async () => {
    const { argv } = warpArgv('read');
    expect(await resolveChains(argv)).to.deep.equal(['healthy']);
    expect(
      argv.context.warpCoreConfig!.tokens.map(
        (token: { chainName: string }) => token.chainName,
      ),
    ).to.deep.equal(['healthy']);
  });

  it('filters apply planning but preserves the full core route', async () => {
    const { argv } = warpArgv('apply');
    expect(await resolveChains(argv)).to.deep.equal(['healthy']);
    expect(Object.keys(argv.context.warpDeployConfig!)).to.deep.equal([
      'healthy',
    ]);
    expect(
      argv.context.warpCoreConfig!.tokens.map(
        (token: { chainName: string }) => token.chainName,
      ),
    ).to.deep.equal(['healthy', 'down']);
  });

  it('filters a down chain from warp check inputs', async () => {
    const { argv } = warpArgv('check');
    expect(await resolveChains(argv)).to.deep.equal(['healthy']);
    expect(Object.keys(argv.context.warpDeployConfig!)).to.deep.equal([
      'healthy',
    ]);
    expect(
      argv.context.warpCoreConfig!.tokens.map(
        (token: { chainName: string }) => token.chainName,
      ),
    ).to.deep.equal(['healthy']);
  });

  it('filters a down chain from combined CROSS route checks', async () => {
    const { argv, setWarpDeployConfig } = warpArgv('check');
    setWarpDeployConfig(null);

    expect(await resolveChains(argv)).to.deep.equal(['healthy']);
    expect(
      argv.context.warpCoreConfig!.tokens.map(
        (token: { chainName: string }) => token.chainName,
      ),
    ).to.deep.equal(['healthy']);
  });

  it('rejects skipping every route chain', async () => {
    const { argv } = warpArgv('apply');
    argv.skipChains = ['healthy', 'down'];
    try {
      await resolveChains(argv);
      expect.fail('Expected resolveChains to reject');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      if (!(error instanceof Error)) throw error;
      expect(error.message).to.equal(
        'Cannot skip every chain in the warp route',
      );
    }
  });

  it('preserves core-only chains so check reports registry drift', async () => {
    const { argv, setWarpDeployConfig } = warpArgv('check');
    argv.skipChains = [];
    const deployConfigWithoutDown = { healthy: deployConfig.healthy };
    setWarpDeployConfig(deployConfigWithoutDown);

    expect(await resolveChains(argv)).to.deep.equal(['healthy']);
    expect(
      argv.context.warpCoreConfig?.tokens.map((token) => token.chainName),
    ).to.deep.equal(['healthy', 'down']);
  });

  it('accepts a skipped chain present only in the core config', async () => {
    const { argv, setWarpDeployConfig } = warpArgv('check');
    const deployConfigWithoutDown = { healthy: deployConfig.healthy };
    setWarpDeployConfig(deployConfigWithoutDown);

    expect(await resolveChains(argv)).to.deep.equal(['healthy']);
    expect(
      argv.context.warpCoreConfig?.tokens.map((token) => token.chainName),
    ).to.deep.equal(['healthy']);
  });

  it('accepts a skipped chain present only in the deploy config', async () => {
    const { argv, setWarpCoreConfig } = warpArgv('read');
    setWarpCoreConfig({ tokens: [coreConfig.tokens[0]] });

    expect(await resolveChains(argv)).to.deep.equal(['healthy']);
    expect(
      argv.context.warpCoreConfig?.tokens.map((token) => token.chainName),
    ).to.deep.equal(['healthy']);
  });
});
