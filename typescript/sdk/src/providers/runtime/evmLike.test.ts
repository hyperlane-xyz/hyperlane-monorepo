import { expect } from 'chai';

import { ProviderType } from '../ProviderType.js';

import { evmLikeRuntimeProviderBuilders } from './evmLike.js';
import { evmRuntimeProviderBuilders } from './evm.js';
import { tronRuntimeProviderBuilders } from './tron.js';

describe('runtime provider builders', () => {
  it('exports a narrow tron runtime builder map', () => {
    expect(tronRuntimeProviderBuilders).to.have.keys([ProviderType.Tron]);
  });

  it('exports a merged evm-like runtime builder map', () => {
    expect(evmLikeRuntimeProviderBuilders).to.include(
      evmRuntimeProviderBuilders,
    );
    expect(evmLikeRuntimeProviderBuilders).to.include(
      tronRuntimeProviderBuilders,
    );
    expect(evmLikeRuntimeProviderBuilders).to.have.keys([
      ProviderType.EthersV5,
      ProviderType.GnosisTxBuilder,
      ProviderType.Viem,
      ProviderType.ZkSync,
      ProviderType.Tron,
    ]);
  });
});
