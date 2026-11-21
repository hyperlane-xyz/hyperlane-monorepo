import { expect } from 'chai';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { type Address, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../utils/files.js';

import {
  CustomTxSubmitterType,
  ExtendedChainSubmissionStrategySchema,
} from './types.js';

describe('ExtendedChainSubmissionStrategySchema', () => {
  const ORIGIN_CHAIN = 'ethereum';
  const DESTINATION_CHAIN = 'arbitrum';
  const ACCESS_MANAGER: Address = '0x3D079E977d644c914a344Dcb5Ba54dB243Cc4863';
  const REFUND_ADDRESS: Address = '0x00000000000000000000000000000000000000AA';
  const FILEPATH = './access-manager-proposals.json';

  function buildAccessManagerOwnedIcaStrategy(
    refundAddress?: Address,
    caller?: Address,
  ) {
    return {
      [DESTINATION_CHAIN]: {
        submitter: {
          type: TxSubmitterType.INTERCHAIN_ACCOUNT,
          chain: ORIGIN_CHAIN,
          refundAddress,
          internalSubmitter: {
            type: TxSubmitterType.ACCESS_MANAGER,
            accessManagerAddress: ACCESS_MANAGER,
            caller,
            proposerSubmitter: {
              type: CustomTxSubmitterType.FILE,
              filepath: FILEPATH,
            },
          },
        },
      },
    };
  }

  it(`should accept a ${CustomTxSubmitterType.FILE} proposer under an AccessManager owned interchain account`, () => {
    const result = ExtendedChainSubmissionStrategySchema.safeParse(
      buildAccessManagerOwnedIcaStrategy(REFUND_ADDRESS),
    );

    assert(result.success, 'Expected parsing to succeed');
    const { submitter } = result.data[DESTINATION_CHAIN];
    assert(
      submitter.type === TxSubmitterType.INTERCHAIN_ACCOUNT,
      `Expected ${TxSubmitterType.INTERCHAIN_ACCOUNT}`,
    );
    expect(submitter.owner).to.equal(ACCESS_MANAGER);
    expect(submitter.destinationChain).to.equal(DESTINATION_CHAIN);
    const { internalSubmitter } = submitter;
    assert(
      internalSubmitter.type === TxSubmitterType.ACCESS_MANAGER,
      `Expected ${TxSubmitterType.ACCESS_MANAGER}`,
    );
    expect(internalSubmitter.chain).to.equal(ORIGIN_CHAIN);
    expect(internalSubmitter.proposerSubmitter).to.deep.equal({
      type: CustomTxSubmitterType.FILE,
      chain: ORIGIN_CHAIN,
      filepath: FILEPATH,
    });
  });

  it(`should reject a missing refundAddress even with a ${CustomTxSubmitterType.FILE} proposer`, () => {
    const result = ExtendedChainSubmissionStrategySchema.safeParse(
      buildAccessManagerOwnedIcaStrategy(),
    );

    assert(!result.success, 'Expected parsing to fail');
    expect(result.error.issues.map(({ message }) => message)).to.deep.equal([
      `Interchain account refundAddress must be set to an address other than the AccessManager for ${DESTINATION_CHAIN}`,
    ]);
  });

  it(`should not compare the AccessManager caller with a ${CustomTxSubmitterType.FILE} proposer`, () => {
    const result = ExtendedChainSubmissionStrategySchema.safeParse(
      buildAccessManagerOwnedIcaStrategy(REFUND_ADDRESS, REFUND_ADDRESS),
    );

    expect(result.success).to.be.true;
  });

  for (const examplePath of [
    './examples/submit/strategy/json-rpc-access-manager-strategy.yaml',
    './examples/submit/strategy/ica-access-manager-strategy.yaml',
  ]) {
    it(`should parse the ${examplePath} example`, () => {
      const result = ExtendedChainSubmissionStrategySchema.safeParse(
        readYamlOrJson(examplePath),
      );
      expect(result.success).to.be.true;
    });
  }
});
