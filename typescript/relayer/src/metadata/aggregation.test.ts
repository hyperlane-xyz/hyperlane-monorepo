import { ethers } from 'ethers';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { IsmType } from '@hyperlane-xyz/sdk';

import {
  AggregationMetadata,
  AggregationMetadataBuilder,
} from './aggregation.js';
import { Fixture } from './fixtures.js';

const path = '../../solidity/fixtures/aggregation';
const files = existsSync(path) ? readdirSync(path) : [];
const fixtures: Fixture<AggregationMetadata>[] = files
  .map((f) => JSON.parse(readFileSync(`${path}/${f}`, 'utf8')))
  .map((contents) => {
    const { encoded, ...values } = contents;
    return {
      encoded,
      decoded: {
        type: IsmType.AGGREGATION,
        submoduleMetadata: Object.values(values).map((value) =>
          value === null || value === 'null' ? null : String(value),
        ),
      },
    };
  });

(fixtures.length === 0 ? describe.skip : describe)(
  'AggregationMetadataBuilder',
  () => {
    fixtures.forEach((fixture, i) => {
      it(`should encode fixture ${i}`, () => {
        expect(AggregationMetadataBuilder.encode(fixture.decoded)).toBe(
          fixture.encoded,
        );
      });

      it(`should decode fixture ${i}`, () => {
        const count = fixture.decoded.submoduleMetadata.length;
        expect(
          AggregationMetadataBuilder.decode(
            fixture.encoded,
            {
              ism: {
                type: IsmType.AGGREGATION,
                modules: Array.from(
                  { length: count },
                  () => ethers.constants.AddressZero,
                ),
                threshold: count,
              },
            } as any,
            () => {
              throw new Error('Should not be called for string modules');
            },
          ),
        ).toEqual(fixture.decoded);
      });
    });
  },
);
