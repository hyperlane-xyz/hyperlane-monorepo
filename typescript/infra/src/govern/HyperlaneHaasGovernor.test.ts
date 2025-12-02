import { expect } from 'chai';
import { BigNumber } from 'ethers';
import sinon from 'sinon';

import {
  HyperlaneCoreChecker,
  InterchainAccount,
  TestChainName,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { AnnotatedCallData } from './HyperlaneAppGovernor.js';
import { HyperlaneHaasGovernor } from './HyperlaneHaasGovernor.js';
import { HyperlaneICAChecker } from './HyperlaneICAChecker.js';

describe('HyperlaneHaasGovernor', () => {
  describe('batchIcaCalls', () => {
    let governor: HyperlaneHaasGovernor;
    let mockIca: InterchainAccount;
    let mockIcaChecker: HyperlaneICAChecker;
    let mockCoreChecker: HyperlaneCoreChecker;
    let mockGetCallRemote: sinon.SinonStub;
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
      sandbox = sinon.createSandbox();

      // Create mock InterchainAccount
      mockIca = {
        getCallRemote: sandbox.stub(),
      } as any;

      // Create mock checkers with proper structure
      mockIcaChecker = {
        app: {
          contractsMap: {
            [TestChainName.test1]: {},
            [TestChainName.test2]: {},
            [TestChainName.test3]: {},
          },
        },
        violations: [],
      } as any;

      mockCoreChecker = {
        app: {
          contractsMap: {
            [TestChainName.test1]: {},
            [TestChainName.test2]: {},
            [TestChainName.test3]: {},
          },
        },
        violations: [],
      } as any;

      // Create governor instance
      governor = new HyperlaneHaasGovernor(
        mockIca,
        mockIcaChecker,
        mockCoreChecker,
      );

      // Set up the interchainAccount property
      (governor as any).interchainAccount = mockIca;
      mockGetCallRemote = mockIca.getCallRemote as sinon.SinonStub;
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('should throw error when interchainAccount is not available', async () => {
      (governor as any).interchainAccount = undefined;

      try {
        await governor.batchIcaCalls();
        expect.fail('Expected an error to be thrown');
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.equal(
          'InterchainAccount is not available',
        );
      }
    });

    it('should handle empty calls array', async () => {
      (governor as any).calls = {
        [TestChainName.test1]: [],
      };

      await governor.batchIcaCalls();

      expect(mockGetCallRemote.called).to.be.false;
    });

    it('should preserve non-ICA calls (calls without callRemoteArgs)', async () => {
      const nonIcaCall: AnnotatedCallData = {
        to: '0x1234567890123456789012345678901234567890' as Address,
        data: '0xabcd',
        value: BigNumber.from(0),
        description: 'Non-ICA call',
      };

      (governor as any).calls = {
        [TestChainName.test1]: [nonIcaCall],
      };

      await governor.batchIcaCalls();

      expect(mockGetCallRemote.called).to.be.false;
      expect((governor as any).calls[TestChainName.test1]).to.deep.equal([
        nonIcaCall,
      ]);
    });

    it('should actually test the grouping logic by verifying different callRemoteArgs create separate groups', async () => {
      // Create calls with different callRemoteArgs that should NOT be grouped together
      const callRemoteArgs1 = {
        chain: TestChainName.test1,
        destination: TestChainName.test2,
        config: {
          origin: TestChainName.test1,
          owner: '0x1111111111111111111111111111111111111111' as Address,
        },
        innerCalls: [],
        hookMetadata: undefined,
      };

      const callRemoteArgs2 = {
        chain: TestChainName.test1,
        destination: TestChainName.test3, // Different destination
        config: {
          origin: TestChainName.test1,
          owner: '0x2222222222222222222222222222222222222222' as Address, // Different owner
        },
        innerCalls: [],
        hookMetadata: undefined,
      };

      const call1: AnnotatedCallData = {
        to: '0x1111111111111111111111111111111111111111' as Address,
        data: '0x1111',
        value: BigNumber.from(100),
        description: 'First ICA call',
        callRemoteArgs: callRemoteArgs1,
      };

      const call2: AnnotatedCallData = {
        to: '0x2222222222222222222222222222222222222222' as Address,
        data: '0x2222',
        value: BigNumber.from(200),
        description: 'Second ICA call',
        callRemoteArgs: callRemoteArgs2,
      };

      (governor as any).calls = {
        [TestChainName.test1]: [call1, call2],
      };

      // Mock the getCallRemote response
      const mockCallRemoteResponse1 = {
        to: '0x9999999999999999999999999999999999999999',
        data: '0xcombined1',
        value: BigNumber.from(100),
      };
      const mockCallRemoteResponse2 = {
        to: '0x8888888888888888888888888888888888888888',
        data: '0xcombined2',
        value: BigNumber.from(200),
      };
      mockGetCallRemote.onFirstCall().resolves(mockCallRemoteResponse1);
      mockGetCallRemote.onSecondCall().resolves(mockCallRemoteResponse2);

      await governor.batchIcaCalls();

      // Verify getCallRemote was called twice (once for each group)
      expect(mockGetCallRemote.calledTwice).to.be.true;

      // Verify the calls were replaced with two separate combined calls
      expect((governor as any).calls[TestChainName.test1]).to.have.length(2);
      const combinedCall1 = (governor as any).calls[TestChainName.test1][0];
      const combinedCall2 = (governor as any).calls[TestChainName.test1][1];

      expect(combinedCall1.description).to.equal('Combined 1 ICA calls');
      expect(combinedCall2.description).to.equal('Combined 1 ICA calls');
    });

    it('should actually test the grouping logic by verifying identical callRemoteArgs create one group', async () => {
      // Create calls with identical callRemoteArgs that SHOULD be grouped together
      const callRemoteArgs = {
        chain: TestChainName.test1,
        destination: TestChainName.test2,
        config: {
          origin: TestChainName.test1,
          owner: '0x1234567890123456789012345678901234567890' as Address,
        },
        innerCalls: [],
        hookMetadata: undefined,
      };

      const call1: AnnotatedCallData = {
        to: '0x1111111111111111111111111111111111111111' as Address,
        data: '0x1111',
        value: BigNumber.from(100),
        description: 'First ICA call',
        callRemoteArgs,
      };

      const call2: AnnotatedCallData = {
        to: '0x2222222222222222222222222222222222222222' as Address,
        data: '0x2222',
        value: BigNumber.from(200),
        description: 'Second ICA call',
        callRemoteArgs, // Same callRemoteArgs as call1
      };

      const call3: AnnotatedCallData = {
        to: '0x3333333333333333333333333333333333333333' as Address,
        data: '0x3333',
        value: BigNumber.from(300),
        description: 'Third ICA call',
        callRemoteArgs, // Same callRemoteArgs as call1 and call2
      };

      (governor as any).calls = {
        [TestChainName.test1]: [call1, call2, call3],
      };

      // Mock the getCallRemote response
      const mockCallRemoteResponse = {
        to: '0x9999999999999999999999999999999999999999',
        data: '0xcombined',
        value: BigNumber.from(600),
      };
      mockGetCallRemote.resolves(mockCallRemoteResponse);

      await governor.batchIcaCalls();

      // Verify getCallRemote was called only once (for the single group)
      expect(mockGetCallRemote.calledOnce).to.be.true;

      // Verify the calls were replaced with a single combined call
      expect((governor as any).calls[TestChainName.test1]).to.have.length(1);
      const combinedCall = (governor as any).calls[TestChainName.test1][0];
      expect(combinedCall.description).to.equal('Combined 3 ICA calls');
      expect(combinedCall.expandedDescription).to.equal(
        'Combined calls: First ICA call, Second ICA call, Third ICA call',
      );

      // Verify the innerCalls were properly combined
      const mockFirstCallArgs = mockGetCallRemote.firstCall.args[0];
      expect(mockFirstCallArgs.innerCalls).to.have.length(3);
      // All should use fallback since innerCalls is undefined
      expect(mockFirstCallArgs.innerCalls[0]).to.deep.equal({
        to: call1.to,
        data: call1.data,
        value: '100',
      });
      expect(mockFirstCallArgs.innerCalls[1]).to.deep.equal({
        to: call2.to,
        data: call2.data,
        value: '200',
      });
      expect(mockFirstCallArgs.innerCalls[2]).to.deep.equal({
        to: call3.to,
        data: call3.data,
        value: '300',
      });
    });

    it('should test the value conversion logic with different value types', async () => {
      const callRemoteArgs = {
        chain: TestChainName.test1,
        destination: TestChainName.test2,
        config: {
          origin: TestChainName.test1,
          owner: '0x1234567890123456789012345678901234567890' as Address,
        },
        innerCalls: [],
        hookMetadata: undefined,
      };

      const call1: AnnotatedCallData = {
        to: '0x1111111111111111111111111111111111111111' as Address,
        data: '0x1111',
        value: undefined, // Undefined value
        description: 'ICA call with undefined value',
        callRemoteArgs,
      };

      const call2: AnnotatedCallData = {
        to: '0x2222222222222222222222222222222222222222' as Address,
        data: '0x2222',
        value: BigNumber.from(0), // Zero value
        description: 'ICA call with zero value',
        callRemoteArgs,
      };

      const call3: AnnotatedCallData = {
        to: '0x3333333333333333333333333333333333333333' as Address,
        data: '0x3333',
        value: BigNumber.from(12345), // Non-zero value
        description: 'ICA call with non-zero value',
        callRemoteArgs,
      };

      (governor as any).calls = {
        [TestChainName.test1]: [call1, call2, call3],
      };

      // Mock the getCallRemote response
      const mockCallRemoteResponse = {
        to: '0x9999999999999999999999999999999999999999',
        data: '0xcombined',
        value: BigNumber.from(12345),
      };
      mockGetCallRemote.resolves(mockCallRemoteResponse);

      await governor.batchIcaCalls();

      // Verify getCallRemote was called with correct value conversions
      expect(mockGetCallRemote.calledOnce).to.be.true;
      const mockFirstCallArgs = mockGetCallRemote.firstCall.args[0];
      expect(mockFirstCallArgs.innerCalls[0].value).to.equal('0'); // undefined -> '0'
      expect(mockFirstCallArgs.innerCalls[1].value).to.equal('0'); // BigNumber(0) -> '0'
      expect(mockFirstCallArgs.innerCalls[2].value).to.equal('12345'); // BigNumber(12345) -> '12345'
    });

    it('should test the actual transformation of the calls structure', async () => {
      const callRemoteArgs = {
        chain: TestChainName.test1,
        destination: TestChainName.test2,
        config: {
          origin: TestChainName.test1,
          owner: '0x1234567890123456789012345678901234567890' as Address,
        },
        innerCalls: [],
        hookMetadata: undefined,
      };

      const icaCall: AnnotatedCallData = {
        to: '0x1111111111111111111111111111111111111111' as Address,
        data: '0x1111',
        value: BigNumber.from(100),
        description: 'ICA call',
        callRemoteArgs,
        submissionType: 'MANUAL' as any,
        governanceType: 'MULTISIG' as any,
      };

      const nonIcaCall: AnnotatedCallData = {
        to: '0x2222222222222222222222222222222222222222' as Address,
        data: '0x2222',
        value: BigNumber.from(200),
        description: 'Non-ICA call',
      };

      (governor as any).calls = {
        [TestChainName.test1]: [icaCall, nonIcaCall],
      };

      // Mock the getCallRemote response
      const mockCallRemoteResponse = {
        to: '0x9999999999999999999999999999999999999999',
        data: '0xcombined',
        value: BigNumber.from(100),
      };
      mockGetCallRemote.resolves(mockCallRemoteResponse);

      await governor.batchIcaCalls();

      // Verify getCallRemote was called once (for the ICA call)
      expect(mockGetCallRemote.calledOnce).to.be.true;

      // Verify the final calls array contains both the combined ICA call and the non-ICA call
      expect((governor as any).calls[TestChainName.test1]).to.have.length(2);
      const finalCalls = (governor as any).calls[TestChainName.test1];

      // One should be the combined ICA call
      const combinedCall = finalCalls.find(
        (call: AnnotatedCallData) =>
          call.description === 'Combined 1 ICA calls',
      );
      expect(combinedCall).to.exist;
      expect(combinedCall?.to).to.equal(mockCallRemoteResponse.to);
      expect(combinedCall?.data).to.equal(mockCallRemoteResponse.data);
      expect(combinedCall?.value).to.equal(mockCallRemoteResponse.value);
      expect(combinedCall?.submissionType).to.equal('MANUAL');
      expect(combinedCall?.governanceType).to.equal('MULTISIG');

      // One should be the non-ICA call (preserved exactly as it was)
      const preservedNonIcaCall = finalCalls.find(
        (call: AnnotatedCallData) => call.description === 'Non-ICA call',
      );
      expect(preservedNonIcaCall).to.exist;
      expect(preservedNonIcaCall?.to).to.equal(nonIcaCall.to);
      expect(preservedNonIcaCall?.data).to.equal(nonIcaCall.data);
      expect(preservedNonIcaCall?.value).to.equal(nonIcaCall.value);
    });

    it('should use innerCalls from callRemoteArgs if present, otherwise fallback to call fields', async () => {
      const callRemoteArgsWithInner = {
        chain: TestChainName.test1,
        destination: TestChainName.test2,
        config: {
          origin: TestChainName.test1,
          owner: '0x1234567890123456789012345678901234567890' as Address,
        },
        innerCalls: [
          { to: '0xabc', data: '0xaaa', value: '42' },
          { to: '0xdef', data: '0xbbb', value: '99' },
        ],
        hookMetadata: undefined,
      };
      const callWithInner: AnnotatedCallData = {
        to: '0xshouldnotbeused' as Address,
        data: '0xshouldnotbeused',
        value: BigNumber.from(123),
        description: 'ICA call with innerCalls',
        callRemoteArgs: callRemoteArgsWithInner,
      };
      const callRemoteArgsNoInner = {
        chain: TestChainName.test1,
        destination: TestChainName.test2,
        config: {
          origin: TestChainName.test1,
          owner: '0x1234567890123456789012345678901234567890' as Address,
        },
        innerCalls: [],
        hookMetadata: undefined,
      };
      const callNoInner: AnnotatedCallData = {
        to: '0xnoinner' as Address,
        data: '0xnoinner',
        value: BigNumber.from(555),
        description: 'ICA call without innerCalls',
        callRemoteArgs: callRemoteArgsNoInner,
      };
      (governor as any).calls = {
        [TestChainName.test1]: [callWithInner, callNoInner],
      };
      const mockCallRemoteResponse = {
        to: '0x999',
        data: '0xcombined',
        value: BigNumber.from(1),
      };
      mockGetCallRemote.resolves(mockCallRemoteResponse);
      await governor.batchIcaCalls();
      expect(mockGetCallRemote.calledOnce).to.be.true;
      const innerCallsArg = mockGetCallRemote.firstCall.args[0].innerCalls;
      // First two should be from callWithInner.callRemoteArgs.innerCalls
      expect(innerCallsArg[0]).to.deep.equal({
        to: '0xabc',
        data: '0xaaa',
        value: '42',
      });
      expect(innerCallsArg[1]).to.deep.equal({
        to: '0xdef',
        data: '0xbbb',
        value: '99',
      });
      // Third should be fallback from callNoInner
      expect(innerCallsArg[2]).to.deep.equal({
        to: '0xnoinner',
        data: '0xnoinner',
        value: '555',
      });
    });
  });
});
