import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import { TokenStandard } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  FALLBACK_TRANSFER_REMOTE_GAS_LIMIT,
  calculateTransferCosts,
  estimateTransferRemoteGas,
} from './gasEstimation.js';

const testLogger = pino({ level: 'silent' });

describe('gasEstimation', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('Tron chain gas estimation', () => {
    // Tron chains use ProtocolType.Ethereum with ChainTechnicalStack.Tron.
    // The gas estimation code routes based on ProtocolType, so Tron chains
    // take the full EVM gas estimation path (provider.estimateGas is called).
    //
    // Note on double-buffering: The rebalancer adds a gas limit buffer via
    // addBufferToGasLimit(), and TronWallet.sendTransaction() independently
    // applies a 1.5x feeLimit multiplier (capped at 1000 TRX). This results
    // in double-buffering — safe but yields higher fee estimates on Tron.

    it('should use EVM gas estimation path for Tron chains (ProtocolType.Ethereum)', async () => {
      const mockAdapter = {
        quoteTransferRemoteGas: sinon.stub().resolves({
          igpQuote: { amount: 1000n },
          tokenFeeQuote: { amount: 0n },
        }),
        populateTransferRemoteTx: sinon.stub().resolves({
          to: '0x1234567890abcdef1234567890abcdef12345678',
          data: '0xdeadbeef',
          value: BigNumber.from(1000),
        }),
      };

      const mockToken = {
        chainName: 'tron',
        standard: TokenStandard.EvmHypCollateral,
        decimals: 6,
        getHypAdapter: sinon.stub().returns(mockAdapter),
      };

      const mockProvider = {
        estimateGas: sinon.stub().resolves(BigNumber.from(150000)),
      };

      const multiProvider = {
        getDomainId: sinon.stub().returns(728126428),
        getProvider: sinon.stub().returns(mockProvider),
        getProtocol: sinon.stub().returns(ProtocolType.Ethereum),
      } as any;

      const getTokenForChain = sinon.stub().returns(mockToken);

      const result = await estimateTransferRemoteGas(
        'tron',
        'ethereum',
        1000000n,
        multiProvider,
        {} as any,
        getTokenForChain,
        '0xInventorySigner',
        testLogger,
      );

      // Should return the actual estimated gas, not the fallback
      expect(result).to.equal(150000n);
      // Should have called provider.estimateGas (EVM path)
      expect(mockProvider.estimateGas.calledOnce).to.be.true;
    });

    it('should fall back to FALLBACK_TRANSFER_REMOTE_GAS_LIMIT when estimateGas fails on Tron', async () => {
      const mockAdapter = {
        quoteTransferRemoteGas: sinon.stub().resolves({
          igpQuote: { amount: 1000n },
          tokenFeeQuote: { amount: 0n },
        }),
        populateTransferRemoteTx: sinon.stub().resolves({
          to: '0x1234567890abcdef1234567890abcdef12345678',
          data: '0xdeadbeef',
          value: BigNumber.from(1000),
        }),
      };

      const mockToken = {
        chainName: 'tron',
        standard: TokenStandard.EvmHypCollateral,
        decimals: 6,
        getHypAdapter: sinon.stub().returns(mockAdapter),
      };

      const mockProvider = {
        estimateGas: sinon.stub().rejects(new Error('Tron RPC error')),
      };

      const multiProvider = {
        getDomainId: sinon.stub().returns(728126428),
        getProvider: sinon.stub().returns(mockProvider),
        getProtocol: sinon.stub().returns(ProtocolType.Ethereum),
      } as any;

      const getTokenForChain = sinon.stub().returns(mockToken);

      const result = await estimateTransferRemoteGas(
        'tron',
        'ethereum',
        1000000n,
        multiProvider,
        {} as any,
        getTokenForChain,
        '0xInventorySigner',
        testLogger,
      );

      expect(result).to.equal(FALLBACK_TRANSFER_REMOTE_GAS_LIMIT);
    });

    it('should calculate non-zero gas cost for Tron native token transfers (EVM path)', async () => {
      const gasEstimate = BigNumber.from(150000);
      const gasPrice = BigNumber.from(420); // Tron uses SUN-denominated gas prices

      const mockAdapter = {
        quoteTransferRemoteGas: sinon.stub().resolves({
          igpQuote: { amount: 500n, addressOrDenom: '' },
          tokenFeeQuote: { amount: 0n },
        }),
        populateTransferRemoteTx: sinon.stub().resolves({
          to: '0x1234567890abcdef1234567890abcdef12345678',
          data: '0xdeadbeef',
          value: BigNumber.from(500),
        }),
      };

      const mockToken = {
        chainName: 'tron',
        standard: TokenStandard.EvmHypNative,
        decimals: 6,
        getHypAdapter: sinon.stub().returns(mockAdapter),
      };

      const mockProvider = {
        estimateGas: sinon.stub().resolves(gasEstimate),
        getFeeData: sinon.stub().resolves({
          maxFeePerGas: null,
          gasPrice,
        }),
      };

      const multiProvider = {
        getDomainId: sinon.stub().returns(728126428),
        getProvider: sinon.stub().returns(mockProvider),
        getProtocol: sinon.stub().returns(ProtocolType.Ethereum),
      } as any;

      const getTokenForChain = sinon.stub().returns(mockToken);
      const isNativeTokenStandard = sinon.stub().returns(true);

      const result = await calculateTransferCosts(
        'tron',
        'ethereum',
        10000000n,
        1000000n,
        multiProvider,
        {} as any,
        getTokenForChain,
        '0xInventorySigner',
        isNativeTokenStandard,
        testLogger,
      );

      // For native tokens on Tron (EVM path), gas cost should be non-zero
      expect(result.gasCost > 0n).to.be.true;
      // IGP cost should be included
      expect(result.igpCost).to.equal(500n);
      // Total should include both
      expect(result.totalCost > 0n).to.be.true;
      // provider.estimateGas should have been called (EVM path, not non-EVM skip)
      expect(mockProvider.estimateGas.calledOnce).to.be.true;
    });
  });
});
