import { expect } from 'chai';

import { assert } from '@hyperlane-xyz/utils';

import { ArtifactNew, ArtifactState } from './artifact.js';
import { ChainLookup } from './chain.js';
import {
  DeployedFeeArtifact,
  FeeArtifactConfig,
  FeeConfig,
  FeeStrategyType,
  FeeType,
  feeArtifactToDerivedConfig,
  feeConfigToArtifact,
  mergeFeeArtifacts,
  shouldDeployNewFee,
} from './fee.js';

const chainLookup: ChainLookup = {
  getChainMetadata: () => {
    throw new Error('not needed');
  },
  getDomainId: (chain) => {
    if (chain === 'ethereum') return 1;
    if (chain === 'polygon') return 137;
    return null;
  },
  getChainName: (domainId: number) => {
    if (domainId === 1) return 'ethereum';
    if (domainId === 137) return 'polygon';
    return null;
  },
  getKnownChainNames: () => ['ethereum', 'polygon'],
};

describe('fee type support', () => {
  describe('feeConfigToArtifact', () => {
    it('passes through linear fee config unchanged', () => {
      const config: FeeConfig = {
        type: FeeType.linear,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        maxFee: '1000',
        halfAmount: '500',
      };

      const artifact = feeConfigToArtifact(config, chainLookup);
      expect(artifact).to.deep.equal({
        artifactState: ArtifactState.NEW,
        config,
      });
    });

    it('passes through regressive fee config unchanged', () => {
      const config: FeeConfig = {
        type: FeeType.regressive,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        maxFee: '2000',
        halfAmount: '1000',
      };

      const artifact = feeConfigToArtifact(config, chainLookup);
      expect(artifact.config).to.deep.equal(config);
    });

    it('passes through progressive fee config unchanged', () => {
      const config: FeeConfig = {
        type: FeeType.progressive,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        maxFee: '3000',
        halfAmount: '1500',
      };

      const artifact = feeConfigToArtifact(config, chainLookup);
      expect(artifact.config).to.deep.equal(config);
    });

    it('passes through offchainQuotedLinear fee config unchanged', () => {
      const config: FeeConfig = {
        type: FeeType.offchainQuotedLinear,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        maxFee: '1000',
        halfAmount: '500',
        quoteSigners: new Set(['0xsigner1']),
      };

      const artifact = feeConfigToArtifact(config, chainLookup);
      expect(artifact.config).to.deep.equal(config);
    });

    it('converts routing fee chain names to domain IDs', () => {
      const config: FeeConfig = {
        type: FeeType.routing,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        routes: {
          ethereum: {
            type: FeeStrategyType.linear,
            maxFee: '1000',
            halfAmount: '500',
          },
          polygon: {
            type: FeeStrategyType.regressive,
            maxFee: '2000',
            halfAmount: '1000',
          },
        },
      };

      const artifact = feeConfigToArtifact(config, chainLookup);
      expect(artifact.config).to.deep.equal({
        type: FeeType.routing,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        quoteSigners: undefined,
        routes: {
          1: {
            type: FeeStrategyType.linear,
            maxFee: '1000',
            halfAmount: '500',
          },
          137: {
            type: FeeStrategyType.regressive,
            maxFee: '2000',
            halfAmount: '1000',
          },
        },
      });
    });

    it('converts CC routing fee chain names to domain IDs', () => {
      const config: FeeConfig = {
        type: FeeType.crossCollateralRouting,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        routes: {
          ethereum: {
            '0xrouter1': {
              type: FeeStrategyType.progressive,
              maxFee: '5000',
              halfAmount: '2500',
            },
          },
        },
      };

      const artifact = feeConfigToArtifact(config, chainLookup);
      expect(artifact.config).to.deep.equal({
        type: FeeType.crossCollateralRouting,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        quoteSigners: undefined,
        routes: {
          1: {
            '0xrouter1': {
              type: FeeStrategyType.progressive,
              maxFee: '5000',
              halfAmount: '2500',
            },
          },
        },
      });
    });

    it('skips unknown chains in routing routes', () => {
      const config: FeeConfig = {
        type: FeeType.routing,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        routes: {
          ethereum: {
            type: FeeStrategyType.linear,
            maxFee: '1000',
            halfAmount: '500',
          },
          unknownchain: {
            type: FeeStrategyType.linear,
            maxFee: '2000',
            halfAmount: '1000',
          },
        },
      };

      const artifact = feeConfigToArtifact(config, chainLookup);
      assert(artifact.config.type === FeeType.routing, 'Expected routing fee');
      expect(Object.keys(artifact.config.routes)).to.deep.equal(['1']);
    });

    it('throws for unsupported fee types', () => {
      expect(() =>
        feeConfigToArtifact(
          { type: 'futureFee' } as unknown as FeeConfig,
          chainLookup,
        ),
      ).to.throw(/Unsupported fee type/);
    });
  });

  describe('feeArtifactToDerivedConfig', () => {
    it('derives linear fee config with address', () => {
      const derived = feeArtifactToDerivedConfig(
        {
          artifactState: ArtifactState.DEPLOYED,
          config: {
            type: FeeType.linear,
            owner: '0xowner',
            beneficiary: '0xbeneficiary',
            maxFee: '1000',
            halfAmount: '500',
          },
          deployed: { address: '0xfee' },
        },
        chainLookup,
      );

      expect(derived).to.deep.equal({
        type: FeeType.linear,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        maxFee: '1000',
        halfAmount: '500',
        address: '0xfee',
      });
    });

    it('converts routing fee domain IDs back to chain names', () => {
      const derived = feeArtifactToDerivedConfig(
        {
          artifactState: ArtifactState.DEPLOYED,
          config: {
            type: FeeType.routing,
            owner: '0xowner',
            beneficiary: '0xbeneficiary',
            routes: {
              1: {
                type: FeeStrategyType.linear,
                maxFee: '1000',
                halfAmount: '500',
              },
              137: {
                type: FeeStrategyType.regressive,
                maxFee: '2000',
                halfAmount: '1000',
              },
            },
          },
          deployed: { address: '0xfee' },
        },
        chainLookup,
      );

      expect(derived).to.deep.equal({
        type: FeeType.routing,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        quoteSigners: undefined,
        routes: {
          ethereum: {
            type: FeeStrategyType.linear,
            maxFee: '1000',
            halfAmount: '500',
          },
          polygon: {
            type: FeeStrategyType.regressive,
            maxFee: '2000',
            halfAmount: '1000',
          },
        },
        address: '0xfee',
      });
    });

    it('throws for unhandled fee types', () => {
      expect(() =>
        feeArtifactToDerivedConfig(
          {
            artifactState: ArtifactState.DEPLOYED,
            config: { type: 'futureFee' } as never,
            deployed: { address: '0xfee' },
          },
          chainLookup,
        ),
      ).to.throw(/Unhandled fee type/);
    });
  });

  describe('shouldDeployNewFee', () => {
    it('requires redeploy when fee type changes', () => {
      const actual: FeeArtifactConfig = {
        type: FeeType.linear,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        maxFee: '1000',
        halfAmount: '500',
      };
      const expected: FeeArtifactConfig = {
        type: FeeType.regressive,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        maxFee: '1000',
        halfAmount: '500',
      };

      expect(shouldDeployNewFee(actual, expected)).to.equal(true);
    });

    it('requires redeploy when linear fee params change', () => {
      const actual: FeeArtifactConfig = {
        type: FeeType.linear,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        maxFee: '1000',
        halfAmount: '500',
      };
      const expected: FeeArtifactConfig = {
        type: FeeType.linear,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        maxFee: '2000',
        halfAmount: '1000',
      };

      expect(shouldDeployNewFee(actual, expected)).to.equal(true);
    });

    it('does not redeploy linear fee when config unchanged', () => {
      const config: FeeArtifactConfig = {
        type: FeeType.linear,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        maxFee: '1000',
        halfAmount: '500',
      };

      expect(shouldDeployNewFee(config, config)).to.equal(false);
    });

    it('requires redeploy when offchainQuotedLinear params change', () => {
      const actual: FeeArtifactConfig = {
        type: FeeType.offchainQuotedLinear,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        maxFee: '1000',
        halfAmount: '500',
      };
      const expected: FeeArtifactConfig = {
        type: FeeType.offchainQuotedLinear,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        maxFee: '2000',
        halfAmount: '500',
      };

      expect(shouldDeployNewFee(actual, expected)).to.equal(true);
    });

    it('does not redeploy routing fee (mutable)', () => {
      const actual: FeeArtifactConfig = {
        type: FeeType.routing,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        routes: {},
      };
      const expected: FeeArtifactConfig = {
        type: FeeType.routing,
        owner: '0xnewowner',
        beneficiary: '0xnewbeneficiary',
        routes: {
          1: {
            type: FeeStrategyType.linear,
            maxFee: '1000',
            halfAmount: '500',
          },
        },
      };

      expect(shouldDeployNewFee(actual, expected)).to.equal(false);
    });

    it('does not redeploy crossCollateralRouting fee (mutable)', () => {
      const actual: FeeArtifactConfig = {
        type: FeeType.crossCollateralRouting,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        routes: {},
      };
      const expected: FeeArtifactConfig = {
        type: FeeType.crossCollateralRouting,
        owner: '0xnewowner',
        beneficiary: '0xnewbeneficiary',
        routes: {
          1: {
            '0xrouter': {
              type: FeeStrategyType.linear,
              maxFee: '1000',
              halfAmount: '500',
            },
          },
        },
      };

      expect(shouldDeployNewFee(actual, expected)).to.equal(false);
    });

    it('throws for unhandled fee types', () => {
      expect(() =>
        shouldDeployNewFee(
          { type: 'futureFee' } as never,
          { type: 'futureFee' } as never,
        ),
      ).to.throw(/Unhandled fee type in shouldDeployNewFee/);
    });
  });

  describe('mergeFeeArtifacts', () => {
    it('returns expected artifact when no current exists', () => {
      const expected: ArtifactNew<FeeArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          type: FeeType.linear,
          owner: '0xowner',
          beneficiary: '0xbeneficiary',
          maxFee: '1000',
          halfAmount: '500',
        },
      };

      const result = mergeFeeArtifacts(undefined, expected);
      expect(result).to.deep.equal(expected);
    });

    it('deploys new fee when type changes', () => {
      const current: DeployedFeeArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: FeeType.linear,
          owner: '0xowner',
          beneficiary: '0xbeneficiary',
          maxFee: '1000',
          halfAmount: '500',
        },
        deployed: { address: '0xold' },
      };

      const expected: ArtifactNew<FeeArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          type: FeeType.regressive,
          owner: '0xowner',
          beneficiary: '0xbeneficiary',
          maxFee: '1000',
          halfAmount: '500',
        },
      };

      const result = mergeFeeArtifacts(current, expected);
      expect(result.artifactState).to.equal(ArtifactState.NEW);
    });

    it('reuses current address for mutable routing fee updates', () => {
      const current: DeployedFeeArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: FeeType.routing,
          owner: '0xowner',
          beneficiary: '0xbeneficiary',
          routes: {},
        },
        deployed: { address: '0xexisting' },
      };

      const expected: ArtifactNew<FeeArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          type: FeeType.routing,
          owner: '0xnewowner',
          beneficiary: '0xbeneficiary',
          routes: {
            1: {
              type: FeeStrategyType.linear,
              maxFee: '1000',
              halfAmount: '500',
            },
          },
        },
      };

      const result = mergeFeeArtifacts(current, expected);
      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect((result as DeployedFeeArtifact).deployed.address).to.equal(
        '0xexisting',
      );
    });

    it('deploys new linear fee when params change', () => {
      const current: DeployedFeeArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: FeeType.linear,
          owner: '0xowner',
          beneficiary: '0xbeneficiary',
          maxFee: '1000',
          halfAmount: '500',
        },
        deployed: { address: '0xold' },
      };

      const expected: ArtifactNew<FeeArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          type: FeeType.linear,
          owner: '0xowner',
          beneficiary: '0xbeneficiary',
          maxFee: '2000',
          halfAmount: '1000',
        },
      };

      const result = mergeFeeArtifacts(current, expected);
      expect(result.artifactState).to.equal(ArtifactState.NEW);
    });
  });
});
