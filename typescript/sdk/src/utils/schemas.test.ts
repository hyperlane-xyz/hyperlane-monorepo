import { expect } from 'chai';
import sinon from 'sinon';
import { z } from 'zod';

import { rootLogger } from '@hyperlane-xyz/utils';

import { isCompliant, validateZodResult } from './schemas.js';

describe('schemas utilities', () => {
  describe('isCompliant', () => {
    const testSchema = z.object({
      name: z.string(),
      age: z.number().int().nonnegative(),
      email: z.string().email().optional(),
    });

    type TestCase<T> = {
      name: string;
      input: T;
    };

    const validTestCases: TestCase<{
      name: string;
      age: number;
      email?: string;
    }>[] = [
      {
        name: 'complete valid object',
        input: { name: 'John', age: 30, email: 'john@example.com' },
      },
      {
        name: 'valid object without optional field',
        input: { name: 'Jane', age: 25 },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should return true for ${name}`, () => {
        const validator = isCompliant(testSchema);
        expect(validator(input)).to.be.true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      {
        name: 'invalid age (negative)',
        input: { name: 'John', age: -1, email: 'john@example.com' },
      },
      {
        name: 'invalid email format',
        input: { name: 'John', age: 30, email: 'not-an-email' },
      },
      {
        name: 'missing required name field',
        input: { age: 30, email: 'john@example.com' },
      },
      {
        name: 'null input',
        input: null,
      },
      {
        name: 'undefined input',
        input: undefined,
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should return false for ${name}`, () => {
        const validator = isCompliant(testSchema);
        expect(validator(input)).to.be.false;
      });
    });
  });

  describe('validateZodResult', () => {
    let loggerWarnStub: sinon.SinonStub;

    beforeEach(() => {
      loggerWarnStub = sinon.stub(rootLogger, 'warn');
    });

    afterEach(() => {
      loggerWarnStub.restore();
    });

    it('should return data for successful parse result', () => {
      const schema = z.object({ name: z.string() });
      const data = { name: 'John' };
      const result = schema.safeParse(data);

      expect(result.success).to.be.true;
      const validatedData = validateZodResult(result);
      expect(validatedData).to.deep.equal(data);
      expect(loggerWarnStub.called).to.be.false;
    });

    type ErrorTestCase<T> = {
      name: string;
      schema: z.ZodSchema<T>;
      input: unknown;
      description: string;
    };

    const errorTestCases: ErrorTestCase<any>[] = [
      {
        name: 'simple type mismatch',
        schema: z.string(),
        input: 123,
        description: 'string input',
      },
      {
        name: 'object validation failure',
        schema: z.object({ name: z.string() }),
        input: { name: 123 },
        description: 'user object',
      },
      {
        name: 'array validation failure',
        schema: z.array(z.string()),
        input: ['valid', 123, 'also valid'],
        description: 'string array',
      },
      {
        name: 'union validation failure',
        schema: z.union([z.string(), z.number()]),
        input: true,
        description: 'string or number',
      },
    ];

    errorTestCases.forEach(({ name, schema, input, description }) => {
      it(`should throw error for ${name}`, () => {
        const result = schema.safeParse(input);
        expect(result.success).to.be.false;
        expect(() => validateZodResult(result, description)).to.throw();
        expect(loggerWarnStub.calledWith(`Invalid ${description}`)).to.be.true;
      });
    });

    it('should include error details in thrown error', () => {
      const schema = z.object({ name: z.string() });
      const result = schema.safeParse({ name: 123 });

      expect(result.success).to.be.false;
      expect(() => validateZodResult(result)).to.throw(/Invalid desc:/);
    });

    it('should handle complex validation errors', () => {
      const complexSchema = z.object({
        user: z.object({
          name: z.string(),
          age: z.number().int().positive(),
        }),
        settings: z.object({
          theme: z.enum(['light', 'dark']),
          notifications: z.boolean(),
        }),
      });

      const invalidData = {
        user: {
          name: 123, // Should be string
          age: -1, // Should be positive
        },
        settings: {
          theme: 'invalid', // Should be 'light' or 'dark'
          notifications: 'true', // Should be boolean
        },
      };

      const result = complexSchema.safeParse(invalidData);
      expect(result.success).to.be.false;
      expect(() => validateZodResult(result, 'complex config')).to.throw();
      expect(loggerWarnStub.calledWith('Invalid complex config')).to.be.true;
    });

    it('should pass through transformed data', () => {
      const transformSchema = z.string().transform((s) => s.toUpperCase());
      const result = transformSchema.safeParse('hello');

      expect(result.success).to.be.true;
      const validatedData = validateZodResult(result);
      expect(validatedData).to.equal('HELLO');
    });

    it('should handle refinement errors', () => {
      const refinedSchema = z.string().refine((s) => s.length > 5, {
        message: 'String must be longer than 5 characters',
      });

      const result = refinedSchema.safeParse('short');
      expect(result.success).to.be.false;
      expect(() => validateZodResult(result, 'long string')).to.throw();
      expect(loggerWarnStub.calledWith('Invalid long string')).to.be.true;
    });

    it('should handle multiple validation errors', () => {
      const multiErrorSchema = z.object({
        name: z.string().min(3),
        age: z.number().int().positive(),
        email: z.string().email(),
      });

      const invalidData = {
        name: 'ab', // Too short
        age: -1, // Not positive
        email: 'not-email', // Invalid email
      };

      const result = multiErrorSchema.safeParse(invalidData);
      expect(result.success).to.be.false;
      expect(() => validateZodResult(result, 'user data')).to.throw();
      expect(loggerWarnStub.calledWith('Invalid user data')).to.be.true;
    });
  });
});
