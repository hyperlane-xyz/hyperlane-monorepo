import { expect } from 'chai';

import { getTimestampForFilename } from './time.js';

describe('getTimestampForFilename', () => {
  it('structures timestamp correctly', () => {
    const filename = getTimestampForFilename();
    expect(filename).to.match(/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}/);
  });
});
