import { expect } from 'vitest';

import {
  getTokenConnectionId,
  parseTokenConnectionId,
} from './TokenConnection.js';
import { ProtocolType } from '@hyperlane-xyz/utils';

describe('TokenConnection', () => {
  it('parses serialized token connection ids', () => {
    const id = getTokenConnectionId(
      ProtocolType.Ethereum,
      'ethereum',
      '0x0000000000000000000000000000000000000001',
    );

    expect(parseTokenConnectionId(id)).toEqual({
      protocol: ProtocolType.Ethereum,
      chainName: 'ethereum',
      addressOrDenom: '0x0000000000000000000000000000000000000001',
    });
  });

  it('rejects malformed token connection ids', () => {
    expect(() => parseTokenConnectionId('just-a-string')).toThrow(
      'Invalid token connection id',
    );
  });
});
