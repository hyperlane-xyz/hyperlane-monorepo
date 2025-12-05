import { expect } from 'chai';

import {
  createEnhancedErrorMessage,
  extractEthersErrorContext,
  formatEthersErrorContext,
  formatRpcCall,
  formatRpcParams,
  getFunctionNameFromSelector,
  getFunctionSelector,
} from './RpcCallFormatting.js';

describe('RpcCallFormatting', () => {
  describe('getFunctionSelector', () => {
    it('should extract function selector from valid data', () => {
      const data =
        '0x70a082310000000000000000000000001234567890123456789012345678901234567890';
      expect(getFunctionSelector(data)).to.equal('0x70a08231');
    });

    it('should return undefined for short data', () => {
      expect(getFunctionSelector('0x70a0')).to.be.undefined;
      expect(getFunctionSelector('')).to.be.undefined;
    });

    it('should handle lowercase input', () => {
      const data =
        '0x70A082310000000000000000000000001234567890123456789012345678901234567890';
      expect(getFunctionSelector(data)).to.equal('0x70a08231');
    });
  });

  describe('getFunctionNameFromSelector', () => {
    it('should return known function names', () => {
      expect(getFunctionNameFromSelector('0x70a08231')).to.equal(
        'balanceOf(address)',
      );
      expect(getFunctionNameFromSelector('0xa9059cbb')).to.equal(
        'transfer(address,uint256)',
      );
      expect(getFunctionNameFromSelector('0x8da5cb5b')).to.equal('owner()');
    });

    it('should return undefined for unknown selectors', () => {
      expect(getFunctionNameFromSelector('0xdeadbeef')).to.be.undefined;
    });

    it('should be case-insensitive', () => {
      expect(getFunctionNameFromSelector('0x70A08231')).to.equal(
        'balanceOf(address)',
      );
    });
  });

  describe('formatRpcParams', () => {
    it('should format call params with known function', () => {
      const params = {
        transaction: {
          to: '0x1234567890123456789012345678901234567890',
          data: '0x70a082310000000000000000000000001234567890123456789012345678901234567890',
        },
      };
      const result = formatRpcParams('call', params);
      expect(result).to.include(
        'to: 0x1234567890123456789012345678901234567890',
      );
      expect(result).to.include('method: balanceOf(address)');
    });

    it('should format call params with unknown function', () => {
      const params = {
        transaction: {
          to: '0x1234567890123456789012345678901234567890',
          data: '0xdeadbeef0000000000000000000000001234567890123456789012345678901234567890',
        },
      };
      const result = formatRpcParams('call', params);
      expect(result).to.include('selector: 0xdeadbeef');
    });

    it('should format getLogs params', () => {
      const params = {
        filter: {
          address: '0x1234567890123456789012345678901234567890',
          fromBlock: 1000,
          toBlock: 2000,
          topics: ['0xabcd'],
        },
      };
      const result = formatRpcParams('getLogs', params);
      expect(result).to.include(
        'address: 0x1234567890123456789012345678901234567890',
      );
      expect(result).to.include('fromBlock: 1000');
      expect(result).to.include('toBlock: 2000');
    });

    it('should format getBalance params', () => {
      const params = { address: '0x1234567890123456789012345678901234567890' };
      const result = formatRpcParams('getBalance', params);
      expect(result).to.equal(
        'address: 0x1234567890123456789012345678901234567890',
      );
    });

    it('should format getTransaction params', () => {
      const params = { transactionHash: '0xabc123' };
      const result = formatRpcParams('getTransaction', params);
      expect(result).to.equal('txHash: 0xabc123');
    });

    it('should return empty string for getBlockNumber', () => {
      const result = formatRpcParams('getBlockNumber', {});
      expect(result).to.equal('');
    });
  });

  describe('formatRpcCall', () => {
    it('should format method with params', () => {
      const result = formatRpcCall('getBalance', {
        address: '0x1234567890123456789012345678901234567890',
      });
      expect(result).to.equal(
        'getBalance(address: 0x1234567890123456789012345678901234567890)',
      );
    });

    it('should return method name only for empty params', () => {
      const result = formatRpcCall('getBlockNumber', {});
      expect(result).to.equal('getBlockNumber');
    });
  });

  describe('extractEthersErrorContext', () => {
    it('should extract standard ethers error properties', () => {
      const error = {
        code: 'CALL_EXCEPTION',
        reason: 'execution reverted',
        method: 'balanceOf(address)',
        transaction: {
          to: '0x1234567890123456789012345678901234567890',
          data: '0x70a08231',
        },
      };
      const context = extractEthersErrorContext(error);
      expect(context.code).to.equal('CALL_EXCEPTION');
      expect(context.reason).to.equal('execution reverted');
      expect(context.method).to.equal('balanceOf(address)');
      expect(context.transaction?.to).to.equal(
        '0x1234567890123456789012345678901234567890',
      );
    });

    it('should handle null/undefined errors', () => {
      expect(extractEthersErrorContext(null)).to.deep.equal({});
      expect(extractEthersErrorContext(undefined)).to.deep.equal({});
    });

    it('should handle nested error info', () => {
      const error = {
        code: 'SERVER_ERROR',
        error: {
          message: 'rate limited',
          code: 429,
        },
      };
      const context = extractEthersErrorContext(error);
      expect(context.error?.message).to.equal('rate limited');
      expect(context.error?.code).to.equal(429);
    });
  });

  describe('formatEthersErrorContext', () => {
    it('should format full context', () => {
      const context = {
        code: 'CALL_EXCEPTION',
        reason: 'execution reverted',
        method: 'transfer(address,uint256)',
        transaction: {
          to: '0x1234567890123456789012345678901234567890',
          data: '0xa9059cbb',
        },
      };
      const result = formatEthersErrorContext(context);
      expect(result).to.include('code: CALL_EXCEPTION');
      expect(result).to.include('reason: execution reverted');
      expect(result).to.include('contractMethod: transfer(address,uint256)');
      expect(result).to.include(
        'to: 0x1234567890123456789012345678901234567890',
      );
    });

    it('should handle empty context', () => {
      expect(formatEthersErrorContext({})).to.equal('');
    });
  });

  describe('createEnhancedErrorMessage', () => {
    it('should create enhanced error message with all context', () => {
      const error = {
        reason: 'execution reverted',
        code: 'CALL_EXCEPTION',
        transaction: {
          to: '0x1234567890123456789012345678901234567890',
        },
      };
      const result = createEnhancedErrorMessage(
        error,
        'call',
        {
          transaction: {
            to: '0x1234567890123456789012345678901234567890',
            data: '0xa9059cbb',
          },
        },
        'ethereum',
      );
      expect(result).to.include('execution reverted');
      expect(result).to.include('ethereum');
      expect(result).to.include('call');
    });

    it('should handle minimal error', () => {
      const result = createEnhancedErrorMessage(
        {},
        'getBlockNumber',
        {},
        'polygon',
      );
      expect(result).to.include('Unknown error');
      expect(result).to.include('polygon');
    });
  });
});
