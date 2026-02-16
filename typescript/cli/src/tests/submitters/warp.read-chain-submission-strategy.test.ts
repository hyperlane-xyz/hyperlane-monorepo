import { tmpdir } from 'os';

import { expect } from 'chai';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';

import { readChainSubmissionStrategy } from '../../deploy/warp.js';
import { writeYamlOrJson } from '../../utils/files.js';

describe('warp readChainSubmissionStrategy hardening', () => {
  const CHAIN = 'anvil2';

  const createStrategyPath = (strategyConfig: Record<string, unknown>) => {
    const strategyPath = `${tmpdir()}/warp-read-chain-submission-strategy-${Date.now()}.yaml`;
    writeYamlOrJson(strategyPath, strategyConfig);
    return strategyPath;
  };

  it('ignores inherited chain strategies from Object prototype', () => {
    const strategyPath = createStrategyPath({});
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      CHAIN,
    );
    Object.defineProperty(Object.prototype, CHAIN, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
      },
    });

    try {
      const parsed = readChainSubmissionStrategy(strategyPath);
      expect(Object.prototype.hasOwnProperty.call(parsed, CHAIN)).to.equal(false);
      expect((parsed as Record<string, unknown>)[CHAIN]).to.equal(undefined);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(Object.prototype, CHAIN, originalDescriptor);
      } else {
        delete (Object.prototype as Record<string, unknown>)[CHAIN];
      }
    }
  });

  it('ignores inherited submitterOverrides from Object prototype', () => {
    const strategyPath = createStrategyPath({
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
      },
    });
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'submitterOverrides',
    );
    Object.defineProperty(Object.prototype, 'submitterOverrides', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: {
        '0x1111111111111111111111111111111111111111': {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          chain: CHAIN,
          safeAddress: '0x7777777777777777777777777777777777777777',
          version: '1.0',
        },
      },
    });

    try {
      const parsed = readChainSubmissionStrategy(strategyPath);
      const chainStrategy = (parsed as Record<string, unknown>)[CHAIN] as Record<
        string,
        unknown
      >;

      expect((chainStrategy.submitter as Record<string, unknown>).type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
      expect(
        Object.prototype.hasOwnProperty.call(chainStrategy, 'submitterOverrides'),
      ).to.equal(false);
      expect(chainStrategy.submitterOverrides).to.equal(undefined);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          Object.prototype,
          'submitterOverrides',
          originalDescriptor,
        );
      } else {
        delete (Object.prototype as Record<string, unknown>).submitterOverrides;
      }
    }
  });

  it('does not throw when Object prototype submitterOverrides is non-writable', () => {
    const strategyPath = createStrategyPath({
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
      },
    });
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'submitterOverrides',
    );
    Object.defineProperty(Object.prototype, 'submitterOverrides', {
      configurable: true,
      enumerable: false,
      value: {},
    });

    try {
      const parsed = readChainSubmissionStrategy(strategyPath);
      const chainStrategy = (parsed as Record<string, unknown>)[CHAIN] as Record<
        string,
        unknown
      >;

      expect((chainStrategy.submitter as Record<string, unknown>).type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
      expect(
        Object.prototype.hasOwnProperty.call(chainStrategy, 'submitterOverrides'),
      ).to.equal(false);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          Object.prototype,
          'submitterOverrides',
          originalDescriptor,
        );
      } else {
        delete (Object.prototype as Record<string, unknown>).submitterOverrides;
      }
    }
  });

  it('does not throw when Object prototype submitter is non-writable', () => {
    const strategyPath = createStrategyPath({
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
      },
    });
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'submitter',
    );
    Object.defineProperty(Object.prototype, 'submitter', {
      configurable: true,
      enumerable: false,
      value: null,
    });

    try {
      const parsed = readChainSubmissionStrategy(strategyPath);
      const chainStrategy = (parsed as Record<string, unknown>)[CHAIN] as Record<
        string,
        unknown
      >;

      expect((chainStrategy.submitter as Record<string, unknown>).type).to.equal(
        TxSubmitterType.JSON_RPC,
      );
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          Object.prototype,
          'submitter',
          originalDescriptor,
        );
      } else {
        delete (Object.prototype as Record<string, unknown>).submitter;
      }
    }
  });
});
