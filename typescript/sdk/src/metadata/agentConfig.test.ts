import { expect } from 'chai';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import {
  GasPaymentEnforcementPolicyType,
  GasPaymentEnforcementSchema,
  buildAgentConfig,
} from './agentConfig.js';

describe('Agent config', () => {
  const args: Parameters<typeof buildAgentConfig> = [
    [TestChainName.test1],
    MultiProvider.createTestMultiProvider(),
    {
      test1: {
        mailbox: '0xmailbox',
        interchainGasPaymaster: '0xgas',
        validatorAnnounce: '0xannounce',
        merkleTreeHook: '0xmerkle',
      },
    },
    { test1: 0 },
  ];

  it('Should generate a new agent config', () => {
    const result = buildAgentConfig(...args);
    expect(result.chains[TestChainName.test1].mailbox).to.equal('0xmailbox');
    expect(result.chains[TestChainName.test1].interchainGasPaymaster).to.equal(
      '0xgas',
    );
    expect(result.chains[TestChainName.test1].validatorAnnounce).to.equal(
      '0xannounce',
    );
    expect(result.chains[TestChainName.test1].merkleTreeHook).to.equal(
      '0xmerkle',
    );
  });
});

describe('GasPaymentEnforcement schema', () => {
  describe('OnChainFeeQuoting gasFraction', () => {
    it('should use default gasFraction of 1/2 when not specified', () => {
      const input = {
        type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
      };

      const result = GasPaymentEnforcementSchema.parse(input) as any;

      expect(result.type).to.equal(
        GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
      );
      expect(result.gasFraction).to.deep.equal({
        numerator: 1,
        denominator: 2,
      });
    });

    it('should parse gasFraction string "1/2" to object', () => {
      const input = {
        type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
        gasFraction: '1/2',
      };

      const result = GasPaymentEnforcementSchema.parse(input) as any;

      expect(result.gasFraction).to.deep.equal({
        numerator: 1,
        denominator: 2,
      });
    });

    it('should parse gasFraction string "3/4" to object', () => {
      const input = {
        type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
        gasFraction: '3/4',
      };

      const result = GasPaymentEnforcementSchema.parse(input) as any;

      expect(result.gasFraction).to.deep.equal({
        numerator: 3,
        denominator: 4,
      });
    });

    it('should parse gasFraction string "1/1" (100% required)', () => {
      const input = {
        type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
        gasFraction: '1/1',
      };

      const result = GasPaymentEnforcementSchema.parse(input) as any;

      expect(result.gasFraction).to.deep.equal({
        numerator: 1,
        denominator: 1,
      });
    });

    it('should parse gasFraction with spaces "1 / 2"', () => {
      const input = {
        type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
        gasFraction: '1 / 2',
      };

      const result = GasPaymentEnforcementSchema.parse(input) as any;

      expect(result.gasFraction).to.deep.equal({
        numerator: 1,
        denominator: 2,
      });
    });

    it('should reject invalid gasFraction format', () => {
      const input = {
        type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
        gasFraction: 'invalid',
      };

      expect(() => GasPaymentEnforcementSchema.parse(input)).to.throw();
    });

    it('should reject gasFraction with zero denominator', () => {
      const input = {
        type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
        gasFraction: '1/0',
      };

      expect(() => GasPaymentEnforcementSchema.parse(input)).to.throw();
    });
  });

  describe('None policy', () => {
    it('should parse None policy', () => {
      const input = {
        type: GasPaymentEnforcementPolicyType.None,
      };

      const result = GasPaymentEnforcementSchema.parse(input);

      expect(result.type).to.equal(GasPaymentEnforcementPolicyType.None);
    });

    it('should parse policy with undefined type as None', () => {
      const input = {};

      const result = GasPaymentEnforcementSchema.parse(input);

      expect(result.type).to.be.undefined;
    });
  });

  describe('Minimum policy', () => {
    it('should parse Minimum policy with payment', () => {
      const input = {
        type: GasPaymentEnforcementPolicyType.Minimum,
        payment: '1000000000000000',
      };

      const result = GasPaymentEnforcementSchema.parse(input) as any;

      expect(result.type).to.equal(GasPaymentEnforcementPolicyType.Minimum);
      expect(result.payment).to.equal('1000000000000000');
    });
  });

  describe('with matchingList', () => {
    it('should parse policy with matchingList', () => {
      const input = {
        type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
        matchingList: [
          {
            originDomain: 1,
            destinationDomain: 2,
          },
        ],
      };

      const result = GasPaymentEnforcementSchema.parse(input);

      expect(result.matchingList).to.have.length(1);
      expect(result.matchingList![0].originDomain).to.equal(1);
    });
  });
});

describe('OnChainFeeQuoting calculation', () => {
  // Test the calculation logic: gasAmount >= gasEstimate * numerator / denominator
  function meetsOnChainFeeQuoting(
    gasAmount: bigint,
    gasEstimate: bigint,
    numerator: number,
    denominator: number,
  ): boolean {
    const requiredGas = (gasEstimate * BigInt(numerator)) / BigInt(denominator);
    return gasAmount >= requiredGas;
  }

  describe('with 1/2 fraction (50% required)', () => {
    const numerator = 1;
    const denominator = 2;

    it('should pass when gasAmount equals 50% of estimate', () => {
      const gasEstimate = BigInt(100000);
      const gasAmount = BigInt(50000); // exactly 50%
      expect(
        meetsOnChainFeeQuoting(gasAmount, gasEstimate, numerator, denominator),
      ).to.be.true;
    });

    it('should pass when gasAmount exceeds 50% of estimate', () => {
      const gasEstimate = BigInt(100000);
      const gasAmount = BigInt(75000); // 75%
      expect(
        meetsOnChainFeeQuoting(gasAmount, gasEstimate, numerator, denominator),
      ).to.be.true;
    });

    it('should fail when gasAmount is below 50% of estimate', () => {
      const gasEstimate = BigInt(100000);
      const gasAmount = BigInt(49999); // just under 50%
      expect(
        meetsOnChainFeeQuoting(gasAmount, gasEstimate, numerator, denominator),
      ).to.be.false;
    });
  });

  describe('with 3/4 fraction (75% required)', () => {
    const numerator = 3;
    const denominator = 4;

    it('should pass when gasAmount equals 75% of estimate', () => {
      const gasEstimate = BigInt(100000);
      const gasAmount = BigInt(75000);
      expect(
        meetsOnChainFeeQuoting(gasAmount, gasEstimate, numerator, denominator),
      ).to.be.true;
    });

    it('should fail when gasAmount is below 75% of estimate', () => {
      const gasEstimate = BigInt(100000);
      const gasAmount = BigInt(74999);
      expect(
        meetsOnChainFeeQuoting(gasAmount, gasEstimate, numerator, denominator),
      ).to.be.false;
    });
  });

  describe('with 1/1 fraction (100% required)', () => {
    const numerator = 1;
    const denominator = 1;

    it('should pass when gasAmount equals estimate', () => {
      const gasEstimate = BigInt(100000);
      const gasAmount = BigInt(100000);
      expect(
        meetsOnChainFeeQuoting(gasAmount, gasEstimate, numerator, denominator),
      ).to.be.true;
    });

    it('should fail when gasAmount is below estimate', () => {
      const gasEstimate = BigInt(100000);
      const gasAmount = BigInt(99999);
      expect(
        meetsOnChainFeeQuoting(gasAmount, gasEstimate, numerator, denominator),
      ).to.be.false;
    });
  });

  describe('edge cases', () => {
    it('should handle zero gas estimate', () => {
      const gasEstimate = BigInt(0);
      const gasAmount = BigInt(0);
      expect(meetsOnChainFeeQuoting(gasAmount, gasEstimate, 1, 2)).to.be.true;
    });

    it('should handle large values', () => {
      const gasEstimate = BigInt('1000000000000000000'); // 1 ETH worth of gas
      const gasAmount = BigInt('500000000000000000'); // 0.5 ETH
      expect(meetsOnChainFeeQuoting(gasAmount, gasEstimate, 1, 2)).to.be.true;
    });
  });
});
