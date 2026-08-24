import { expect } from 'chai';

import { IsmType } from '../ism/types.js';

import { randomIsmConfig } from './testUtils.js';

describe('randomIsmConfig', () => {
  const generatedTypes = [
    IsmType.MAILBOX_DEFAULT,
    IsmType.RATE_LIMITED,
    IsmType.BLACKLIST,
    IsmType.TRUSTED_RELAYER,
  ];

  for (const ismType of generatedTypes) {
    it(`returns a ${ismType} config when asked for one`, () => {
      expect(randomIsmConfig(0, 2, ismType).type).to.equal(ismType);
    });
  }

  // Both share the NULL module type with the generated types above, so a
  // fallback branch would hand back a trusted relayer config instead.
  const unsupportedTypes = [
    IsmType.NET_FLOW_RATE_LIMITED,
    IsmType.DELAYED_FLOW_ROUTER,
  ];

  for (const ismType of unsupportedTypes) {
    it(`refuses to generate a ${ismType} config`, () => {
      expect(() => randomIsmConfig(0, 2, ismType)).to.throw(ismType);
    });
  }
});
