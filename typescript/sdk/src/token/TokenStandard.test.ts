import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { TokenType } from './config.js';
import { TokenStandard, tokenTypeToStandard } from './TokenStandard.js';

describe('tokenTypeToStandard', () => {
  it('maps the native katana vault helper to the native EVM standard', () => {
    expect(
      tokenTypeToStandard(
        ProtocolType.Ethereum,
        TokenType.nativeKatanaVaultHelper,
      ),
    ).to.equal(TokenStandard.EvmHypNative);
  });
});
