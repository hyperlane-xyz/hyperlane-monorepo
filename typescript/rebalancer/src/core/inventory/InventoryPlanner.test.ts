import { expect } from 'chai';
import { pino } from 'pino';

import type {
  ChainName,
  MultiProvider,
  Token,
  WarpCore,
} from '@hyperlane-xyz/sdk';

import {
  InventoryPlanner,
  isRecoverableMaxTransferProbeError,
} from './InventoryPlanner.js';

const logger = pino({ level: 'silent' });

describe('InventoryPlanner', () => {
  const arbitrum = 'arbitrum' as ChainName;
  const base = 'base' as ChainName;
  const solana = 'solanamainnet' as ChainName;
  let balances: Map<ChainName, bigint>;
  let consumed: Map<ChainName, bigint>;
  let planner: InventoryPlanner;

  beforeEach(() => {
    balances = new Map<ChainName, bigint>([
      [arbitrum, 100n],
      [base, 60n],
      [solana, 30n],
    ]);
    consumed = new Map<ChainName, bigint>([[arbitrum, 25n]]);
    planner = new InventoryPlanner(
      () => balances,
      () => consumed,
      {} as MultiProvider,
      {} as WarpCore,
      () => undefined,
      () => '0x0000000000000000000000000000000000000000',
      logger,
    );
  });

  it('accounts for consumed inventory when selecting bridge sources', () => {
    const sources = planner.selectAllSourceChains(solana);

    expect(sources).to.deep.equal([
      { chain: arbitrum, availableAmount: 75n },
      { chain: base, availableAmount: 60n },
    ]);
  });

  it('builds buffered bridge plans without inflating each split', () => {
    const { bridgePlans, shortfall, targetWithBuffer, totalPlanned } =
      planner.buildBridgePlans(
        [
          { chain: arbitrum, maxSourceInput: 100n, maxTargetOutput: 60n },
          { chain: base, maxSourceInput: 100n, maxTargetOutput: 60n },
        ],
        100n,
        0n,
        0n,
      );

    expect(shortfall).to.equal(100n);
    expect(targetWithBuffer).to.equal(105n);
    expect(totalPlanned).to.equal(105n);
    expect(bridgePlans).to.deep.equal([
      {
        chain: arbitrum,
        maxSourceInput: 100n,
        targetOutput: 60n,
        quoteMode: 'forward',
      },
      {
        chain: base,
        maxSourceInput: 100n,
        targetOutput: 45n,
        quoteMode: 'reverse',
      },
    ]);
  });

  it('includes transfer costs before applying the bridge buffer', () => {
    const { bridgePlans, shortfall, targetWithBuffer, totalPlanned } =
      planner.buildBridgePlans(
        [{ chain: arbitrum, maxSourceInput: 200n, maxTargetOutput: 200n }],
        100n,
        40n,
        20n,
      );

    expect(shortfall).to.equal(60n);
    expect(targetWithBuffer).to.equal(84n);
    expect(totalPlanned).to.equal(84n);
    expect(bridgePlans).to.deep.equal([
      {
        chain: arbitrum,
        maxSourceInput: 200n,
        targetOutput: 84n,
        quoteMode: 'reverse',
      },
    ]);
  });

  it('aligns local inventory amounts to canonical progress', () => {
    const token = {
      scale: { numerator: 1n, denominator: 1_000n },
    } as Token;

    const aligned = planner.alignLocalToCanonical(1_999n, token);

    expect(aligned).to.deep.equal({
      localAmount: 1_000n,
      messageAmount: 1n,
    });
  });

  it('detects nested recoverable max-transfer probe errors', () => {
    const error = new Error('outer') as Error & { cause?: unknown };
    error.cause = {
      code: 'UNPREDICTABLE_GAS_LIMIT',
      error: {
        message: 'ERC20: transfer amount exceeds balance',
      },
    };

    expect(isRecoverableMaxTransferProbeError(error)).to.equal(true);
    expect(isRecoverableMaxTransferProbeError(new Error('RPC down'))).to.equal(
      false,
    );
  });
});
