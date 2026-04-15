import { expect } from 'chai';
import { z } from 'zod';

import { validateZodResult } from './schemas.js';

describe('validateZodResult', () => {
  it('returns parsed data on success', () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 'hello' });
    expect(validateZodResult(result)).to.deep.equal({ name: 'hello' });
  });

  it('throws on validation failure', () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 123 });
    expect(() => validateZodResult(result)).to.throw();
  });

  it('returns output type for schemas with transforms', () => {
    const schema = z.object({
      value: z.string().transform((s) => parseInt(s, 10)),
    });
    const result = schema.safeParse({ value: '42' });
    const parsed = validateZodResult(result);
    expect(parsed.value).to.equal(42);
    expect(typeof parsed.value).to.equal('number');
  });

  it('handles schemas with bigint coercion', () => {
    const schema = z.object({
      amount: z.bigint().or(z.string().regex(/^\d+$/).transform(BigInt)),
    });
    const result = schema.safeParse({ amount: '1000000000000' });
    const parsed = validateZodResult(result);
    expect(parsed.amount).to.equal(1000000000000n);
  });
});
