import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { GasPriceManager } from '../../src/execution/GasPriceManager';
import { GasFeeEstimates } from '../../src/types';

describe('GasPriceManager', () => {
  let gasPriceManager: GasPriceManager;
  let mockProvider: any;

  beforeEach(() => {
    gasPriceManager = new GasPriceManager();
    mockProvider = sinon.createStubInstance(ethers.JsonRpcProvider);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should calculate EIP-1559 fee estimates with buffer', async () => {
    mockProvider.getFeeData.resolves({
      maxFeePerGas: ethers.parseUnits('30', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
      gasPrice: null,
    });

    const estimates = await gasPriceManager.getFeeEstimates(mockProvider, 1.2);
    expect(estimates.maxPriorityFeePerGas).to.equal(ethers.parseUnits('2.4', 'gwei')); // 2 * 1.2
    expect(estimates.maxFeePerGas).to.equal(ethers.parseUnits('36', 'gwei')); // 30 * 1.2
  });

  it('should calculate legacy gasPrice with buffer when EIP-1559 is not supported', async () => {
    mockProvider.getFeeData.resolves({
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      gasPrice: ethers.parseUnits('20', 'gwei'),
    });

    const estimates = await gasPriceManager.getFeeEstimates(mockProvider, 1.2);
    expect(estimates.gasPrice).to.equal(ethers.parseUnits('24', 'gwei')); // 20 * 1.2
    expect(estimates.maxFeePerGas).to.be.undefined;
  });

  it('should bump fee estimates by 20% on retry', () => {
    const currentFee: GasFeeEstimates = {
      maxFeePerGas: ethers.parseUnits('50', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
      gasLimit: 21000n,
    };

    const bumped = gasPriceManager.bumpFeeEstimates(currentFee, 20);
    expect(bumped.maxPriorityFeePerGas).to.equal(ethers.parseUnits('2.4', 'gwei')); // 2 * 1.2
    expect(bumped.maxFeePerGas).to.equal(ethers.parseUnits('60', 'gwei')); // 50 * 1.2
  });

  it('should bump legacy gasPrice by 20%', () => {
    const currentFee: GasFeeEstimates = {
      gasPrice: ethers.parseUnits('30', 'gwei'),
      gasLimit: 21000n,
    };

    const bumped = gasPriceManager.bumpFeeEstimates(currentFee, 20);
    expect(bumped.gasPrice).to.equal(ethers.parseUnits('36', 'gwei')); // 30 * 1.2
  });
});
