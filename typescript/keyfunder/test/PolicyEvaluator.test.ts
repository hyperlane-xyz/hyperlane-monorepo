import { expect } from 'chai';
import { ethers } from 'ethers';
import { PolicyEvaluator } from '../src/core/PolicyEvaluator';
import { ChainBalanceReport, ChainFundingConfig, FunderConfig, FundingPolicy } from '../src/types';

describe('PolicyEvaluator', () => {
  let evaluator: PolicyEvaluator;

  beforeEach(() => {
    evaluator = new PolicyEvaluator();
  });

  const chainConfig: ChainFundingConfig = {
    chain: 'ethereum',
    protocol: 'ethereum',
    nativeDecimals: 18,
    nativeSymbol: 'ETH',
    strategy: 'direct',
    recipients: [
      {
        name: 'validator-1',
        address: '0xValidator1',
        minBalance: '0.5',
        desiredBalance: '2.0',
        maxFundingAmount: '1.0',
      },
      {
        name: 'relayer-1',
        address: '0xRelayer1',
        minBalance: '0.2',
        desiredBalance: '1.0',
      },
      {
        name: 'deployer-1',
        address: '0xDeployer1',
        minBalance: '1.0',
        desiredBalance: '3.0',
      },
    ],
  };

  it('should evaluate funding actions with maxFunding cap properly', () => {
    const report: ChainBalanceReport = {
      chain: 'ethereum',
      protocol: 'ethereum',
      funderAddress: '0xFunder',
      funderBalance: ethers.parseEther('100.0'),
      formattedFunderBalance: '100.0',
      recipientBalances: [
        {
          recipient: '0xValidator1',
          name: 'validator-1',
          balance: ethers.parseEther('0.1'), // < min 0.5, deficit is 1.9, but maxFunding is 1.0
          formattedBalance: '0.1',
          minBalance: ethers.parseEther('0.5'),
          formattedMinBalance: '0.5',
          desiredBalance: ethers.parseEther('2.0'),
          formattedDesiredBalance: '2.0',
          needsFunding: true,
          deficit: ethers.parseEther('1.9'),
          formattedDeficit: '1.9',
        },
      ],
    };

    const actions = evaluator.evaluateChain('ethereum', chainConfig, report);
    expect(actions).to.have.lengthOf(1);
    expect(actions[0].status).to.equal('PENDING');
    expect(actions[0].requiredFunding).to.equal(ethers.parseEther('1.0')); // Capped by maxFundingAmount
    expect(actions[0].formattedRequiredFunding).to.equal('1.0');
  });

  it('should skip funding when recipient balance >= minBalance', () => {
    const report: ChainBalanceReport = {
      chain: 'ethereum',
      protocol: 'ethereum',
      funderAddress: '0xFunder',
      funderBalance: ethers.parseEther('100.0'),
      formattedFunderBalance: '100.0',
      recipientBalances: [
        {
          recipient: '0xRelayer1',
          name: 'relayer-1',
          balance: ethers.parseEther('0.5'), // >= min 0.2
          formattedBalance: '0.5',
          minBalance: ethers.parseEther('0.2'),
          formattedMinBalance: '0.2',
          desiredBalance: ethers.parseEther('1.0'),
          formattedDesiredBalance: '1.0',
          needsFunding: false,
          deficit: 0n,
          formattedDeficit: '0.0',
        },
      ],
    };

    const actions = evaluator.evaluateChain('ethereum', chainConfig, report);
    expect(actions).to.have.lengthOf(1);
    expect(actions[0].status).to.equal('SKIPPED');
    expect(actions[0].requiredFunding).to.equal(0n);
    expect(actions[0].skipReason).to.include('>= minThreshold');
  });

  it('should enforce funder minimum reserve floor', () => {
    const funderConfig: FunderConfig = {
      type: 'privateKey',
      minReserve: '5.0', // Must keep 5 ETH
    };

    // Funder only has 5.5 ETH, validator needs 1.0 ETH
    // Available reserve = 0.5 ETH
    const report: ChainBalanceReport = {
      chain: 'ethereum',
      protocol: 'ethereum',
      funderAddress: '0xFunder',
      funderBalance: ethers.parseEther('5.5'),
      formattedFunderBalance: '5.5',
      recipientBalances: [
        {
          recipient: '0xValidator1',
          name: 'validator-1',
          balance: ethers.parseEther('0.1'),
          formattedBalance: '0.1',
          minBalance: ethers.parseEther('0.5'),
          formattedMinBalance: '0.5',
          desiredBalance: ethers.parseEther('2.0'),
          formattedDesiredBalance: '2.0',
          needsFunding: true,
          deficit: ethers.parseEther('1.9'),
          formattedDeficit: '1.9',
        },
      ],
    };

    const actions = evaluator.evaluateChain(
      'ethereum',
      chainConfig,
      report,
      undefined,
      funderConfig
    );
    expect(actions).to.have.lengthOf(1);
    expect(actions[0].status).to.equal('PENDING');
    // Required funding should be capped to the available reserve of 0.5 ETH
    expect(actions[0].requiredFunding).to.equal(ethers.parseEther('0.5'));
  });

  it('should skip funding completely if funder balance is below reserve floor', () => {
    const funderConfig: FunderConfig = {
      type: 'privateKey',
      minReserve: '5.0',
    };

    const report: ChainBalanceReport = {
      chain: 'ethereum',
      protocol: 'ethereum',
      funderAddress: '0xFunder',
      funderBalance: ethers.parseEther('4.0'), // Below reserve floor of 5.0
      formattedFunderBalance: '4.0',
      recipientBalances: [
        {
          recipient: '0xValidator1',
          name: 'validator-1',
          balance: ethers.parseEther('0.1'),
          formattedBalance: '0.1',
          minBalance: ethers.parseEther('0.5'),
          formattedMinBalance: '0.5',
          desiredBalance: ethers.parseEther('2.0'),
          formattedDesiredBalance: '2.0',
          needsFunding: true,
          deficit: ethers.parseEther('1.9'),
          formattedDeficit: '1.9',
        },
      ],
    };

    const actions = evaluator.evaluateChain(
      'ethereum',
      chainConfig,
      report,
      undefined,
      funderConfig
    );
    expect(actions).to.have.lengthOf(1);
    expect(actions[0].status).to.equal('SKIPPED');
    expect(actions[0].skipReason).to.include('reserve floor');
  });

  it('should resolve named policies correctly', () => {
    const customPolicies: Record<string, FundingPolicy> = {
      relayerPolicy: {
        minBalance: '0.8',
        desiredBalance: '2.5',
        maxFundingAmount: '1.7',
      },
    };

    const customChainConfig: ChainFundingConfig = {
      protocol: 'ethereum',
      recipients: [
        {
          address: '0xCustomRecipient',
          policy: 'relayerPolicy',
        },
      ],
    };

    const report: ChainBalanceReport = {
      chain: 'ethereum',
      protocol: 'ethereum',
      funderAddress: '0xFunder',
      funderBalance: ethers.parseEther('10.0'),
      formattedFunderBalance: '10.0',
      recipientBalances: [
        {
          recipient: '0xCustomRecipient',
          balance: ethers.parseEther('0.2'),
          formattedBalance: '0.2',
          minBalance: ethers.parseEther('0.8'),
          formattedMinBalance: '0.8',
          desiredBalance: ethers.parseEther('2.5'),
          formattedDesiredBalance: '2.5',
          needsFunding: true,
          deficit: ethers.parseEther('2.3'),
          formattedDeficit: '2.3',
        },
      ],
    };

    const actions = evaluator.evaluateChain(
      'ethereum',
      customChainConfig,
      report,
      customPolicies
    );
    expect(actions[0].status).to.equal('PENDING');
    // Deficit is 2.3, maxFundingAmount is 1.7
    expect(actions[0].requiredFunding).to.equal(ethers.parseEther('1.7'));
  });
});
