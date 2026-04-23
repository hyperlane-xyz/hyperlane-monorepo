import { expect } from 'vitest';

import { ProviderType } from '../ProviderType.js';

import { evmLikeRuntimeProviderBuilders } from './evmLike.js';
import { evmRuntimeProviderBuilders } from './evm.js';
import { tronRuntimeProviderBuilders } from './tron.js';

describe('runtime provider builders', () => {
  it('exports a narrow tron runtime builder map', () => {
    expect(Object.keys(tronRuntimeProviderBuilders).sort()).toEqual(
      [ProviderType.Tron].sort(),
    );
  });

  it('exports a merged evm-like runtime builder map', () => {
    expect(evmLikeRuntimeProviderBuilders).toMatchObject(
      evmRuntimeProviderBuilders,
    );
    expect(evmLikeRuntimeProviderBuilders).toMatchObject(
      tronRuntimeProviderBuilders,
    );
    expect(Object.keys(evmLikeRuntimeProviderBuilders).sort()).toEqual(
      [
        ProviderType.EthersV5,
        ProviderType.GnosisTxBuilder,
        ProviderType.Viem,
        ProviderType.ZkSync,
        ProviderType.Tron,
      ].sort(),
    );
  });
});
