import { expect } from 'vitest';

import { getTimestampForFilename } from './time.js';

describe('getTimestampForFilename', () => {
  it('structures timestamp correctly', () => {
    const filename = getTimestampForFilename();
    expect(filename).toMatch(/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}/);
  });
});
