import { expect } from 'chai';

import { HookType as ProviderHookType } from '@hyperlane-xyz/provider-sdk/hook';
import { IsmType as ProviderIsmType } from '@hyperlane-xyz/provider-sdk/ism';
import { TokenType as ProviderTokenType } from '@hyperlane-xyz/provider-sdk/warp';

import { HookType } from './hook/types.js';
import { IsmType } from './ism/types.js';
import { TokenType } from './token/config.js';

describe('provider-sdk artifact type parity', () => {
  it('uses the provider hook discriminator catalog', () => {
    expect(HookType).to.equal(ProviderHookType);
  });

  it('uses the provider ISM discriminator catalog', () => {
    expect(IsmType).to.equal(ProviderIsmType);
  });

  it('uses the provider token discriminator catalog', () => {
    expect(TokenType).to.equal(ProviderTokenType);
  });
});
