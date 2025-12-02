import { expect } from 'chai';
import { ethers } from 'ethers';

import { AggregationIsmConfigSchema, IsmType } from './types.js';

const SOME_ADDRESS = ethers.Wallet.createRandom().address;
describe('AggregationIsmConfigSchema refine', () => {
  it('should require threshold to be below modules length', () => {
    const IsmConfig = {
      type: IsmType.AGGREGATION,
      modules: [SOME_ADDRESS],
      threshold: 100,
    };
    expect(AggregationIsmConfigSchema.safeParse(IsmConfig).success).to.be.false;

    IsmConfig.threshold = 0;
    expect(AggregationIsmConfigSchema.safeParse(IsmConfig).success).to.be.true;
  });
});
