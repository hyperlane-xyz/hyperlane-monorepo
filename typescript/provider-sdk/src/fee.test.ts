import { expect } from 'chai';

import { assert } from '@hyperlane-xyz/utils';

import { ArtifactNew, ArtifactState } from './artifact.js';
import { ChainLookup } from './chain.js';
import {
  CrossCollateralRoutingFeeArtifactConfig,
  DeployedFeeArtifact,
  DerivedFeeConfig,
  FeeArtifactConfig,
  FeeConfig,
  FeeParams,
  FeeParamsType,
  FeeStrategyType,
  FeeType,
  RoutingFeeArtifactConfig,
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

const rawParams = (maxFee: string, halfAmount: string): FeeParams => ({
  type: FeeParamsType.raw,
  maxFee,
  halfAmount,
});

describe('fee type support', () => {
  describe('feeConfigToArtifact', () => {
    it('passes through linear fee config unchanged', () => {
      const config: FeeConfig = {
        type: FeeType.linear,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        params: rawParams('1000', '500'),
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
        params: rawParams('2000', '1000'),
      };

      const artifact = feeConfigToArtifact(config, chainLookup);
      expect(artifact.config).to.deep.equal(config);
    });

    it('passes through progressive fee config unchanged', () => {
      const config: FeeConfig = {
        type: FeeType.progressive,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        params: rawParams('3000', '1500'),
      };

      const artifact = feeConfigToArtifact(config, chainLookup);
      expect(artifact.config).to.deep.equal(config);
    });

    it('passes through offchainQuotedLinear fee config unchanged', () => {
      const config: FeeConfig = {
        type: FeeType.offchainQuotedLinear,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        params: rawParams('1000', '500'),
        quoteSigners: ['0xsigner1'],
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
            params: rawParams('1000', '500'),
          },
          polygon: {
            type: FeeStrategyType.regressive,
            params: rawParams('2000', '1000'),
          },
        },
      };

      const artifact = feeConfigToArtifact(config, chainLookup);
      const expectedArtifactConfig: RoutingFeeArtifactConfig = {
        type: FeeType.routing,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        routes: {
          1: {
            type: FeeStrategyType.linear,
            params: rawParams('1000', '500'),
          },
          137: {
            type: FeeStrategyType.regressive,
            params: rawParams('2000', '1000'),
          },
        },
        token: undefined,
      };
      expect(artifact.config).to.deep.equal(expectedArtifactConfig);
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
              params: rawParams('5000', '2500'),
            },
          },
        },
      };

      const artifact = feeConfigToArtifact(config, chainLookup);
      const expectedArtifactConfig: CrossCollateralRoutingFeeArtifactConfig = {
        type: FeeType.crossCollateralRouting,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        routes: {
          1: {
            '0xrouter1': {
              type: FeeStrategyType.progressive,
              params: rawParams('5000', '2500'),
            },
          },
        },
        token: undefined,
      };
      expect(artifact.config).to.deep.equal(expectedArtifactConfig);
    });

    it('skips unknown chains in routing routes', () => {
      const config: FeeConfig = {
        type: FeeType.routing,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        routes: {
          ethereum: {
            type: FeeStrategyType.linear,
            params: rawParams('1000', '500'),
          },
          unknownchain: {
            type: FeeStrategyType.linear,
            params: rawParams('2000', '1000'),
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
    const TOKEN = '0xtoken';

    it('derives linear fee config with resolved bigints and bps', () => {
      const derived = feeArtifactToDerivedConfig(
        {
          artifactState: ArtifactState.DEPLOYED,
          config: {
            type: FeeType.linear,
            owner: '0xowner',
            beneficiary: '0xbeneficiary',
            params: rawParams('1000', '500'),
          },
          deployed: { address: '0xfee' },
        },
        chainLookup,
        TOKEN,
      );

      expect(derived).to.deep.equal({
        type: FeeType.linear,
        token: TOKEN,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        maxFee: 1000n,
        halfAmount: 500n,
        bps: 10000,
        address: '0xfee',
      });
    });

    it('converts routing fee domain IDs back to chain names with derived entries', () => {
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
                params: rawParams('1000', '500'),
              },
              137: {
                type: FeeStrategyType.regressive,
                params: rawParams('2000', '1000'),
              },
            },
          },
          deployed: { address: '0xfee' },
        },
        chainLookup,
        TOKEN,
      );

      const expectedDerived: DerivedFeeConfig = {
        type: FeeType.routing,
        token: TOKEN,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        feeContracts: {
          ethereum: {
            type: FeeStrategyType.linear,
            token: TOKEN,
            owner: '0xowner',
            beneficiary: '0xbeneficiary',
            maxFee: 1000n,
            halfAmount: 500n,
            bps: 10000,
            address: '0xfee',
          },
          polygon: {
            type: FeeStrategyType.regressive,
            token: TOKEN,
            owner: '0xowner',
            beneficiary: '0xbeneficiary',
            maxFee: 2000n,
            halfAmount: 1000n,
            bps: 10000,
            address: '0xfee',
          },
        },
        address: '0xfee',
      };
      expect(derived).to.deep.equal(expectedDerived);
    });

    it('converts crossCollateralRouting fee domain IDs back to chain names', () => {
      const derived = feeArtifactToDerivedConfig(
        {
          artifactState: ArtifactState.DEPLOYED,
          config: {
            type: FeeType.crossCollateralRouting,
            owner: '0xowner',
            beneficiary: '0xbeneficiary',
            routes: {
              1: {
                '0xrouter1': {
                  type: FeeStrategyType.linear,
                  params: rawParams('1000', '500'),
                },
              },
              137: {
                '0xrouter2': {
                  type: FeeStrategyType.regressive,
                  params: rawParams('2000', '1000'),
                },
              },
            },
          },
          deployed: { address: '0xfee' },
        },
        chainLookup,
        TOKEN,
      );

      const expectedDerived: DerivedFeeConfig = {
        type: FeeType.crossCollateralRouting,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        feeContracts: {
          ethereum: {
            '0xrouter1': {
              type: FeeStrategyType.linear,
              token: TOKEN,
              owner: '0xowner',
              beneficiary: '0xbeneficiary',
              maxFee: 1000n,
              halfAmount: 500n,
              bps: 10000,
              address: '0xfee',
            },
          },
          polygon: {
            '0xrouter2': {
              type: FeeStrategyType.regressive,
              token: TOKEN,
              owner: '0xowner',
              beneficiary: '0xbeneficiary',
              maxFee: 2000n,
              halfAmount: 1000n,
              bps: 10000,
              address: '0xfee',
            },
          },
        },
        address: '0xfee',
      };
      expect(derived).to.deep.equal(expectedDerived);
    });

    it('skips unknown domain IDs in routing fee derived config', () => {
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
                params: rawParams('1000', '500'),
              },
              99999: {
                type: FeeStrategyType.regressive,
                params: rawParams('2000', '1000'),
              },
            },
          },
          deployed: { address: '0xfee' },
        },
        chainLookup,
        TOKEN,
      );

      assert(derived.type === FeeType.routing, 'Expected routing');
      expect(Object.keys(derived.feeContracts)).to.deep.equal(['ethereum']);
    });

    it('skips unknown domain IDs in crossCollateralRouting fee derived config', () => {
      const derived = feeArtifactToDerivedConfig(
        {
          artifactState: ArtifactState.DEPLOYED,
          config: {
            type: FeeType.crossCollateralRouting,
            owner: '0xowner',
            beneficiary: '0xbeneficiary',
            routes: {
              1: {
                '0xrouter1': {
                  type: FeeStrategyType.linear,
                  params: rawParams('1000', '500'),
                },
              },
              99999: {
                '0xrouter2': {
                  type: FeeStrategyType.progressive,
                  params: rawParams('3000', '1500'),
                },
              },
            },
          },
          deployed: { address: '0xfee' },
        },
        chainLookup,
        TOKEN,
      );

      assert(
        derived.type === FeeType.crossCollateralRouting,
        'Expected CC routing',
      );
      expect(Object.keys(derived.feeContracts)).to.deep.equal(['ethereum']);
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
          TOKEN,
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
        params: rawParams('1000', '500'),
      };
      const expected: FeeArtifactConfig = {
        type: FeeType.regressive,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        params: rawParams('1000', '500'),
      };

      expect(shouldDeployNewFee(actual, expected)).to.equal(true);
    });

    it('requires redeploy when linear fee params change', () => {
      const actual: FeeArtifactConfig = {
        type: FeeType.linear,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        params: rawParams('1000', '500'),
      };
      const expected: FeeArtifactConfig = {
        type: FeeType.linear,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        params: rawParams('2000', '1000'),
      };

      expect(shouldDeployNewFee(actual, expected)).to.equal(true);
    });

    it('does not redeploy linear fee when config unchanged', () => {
      const config: FeeArtifactConfig = {
        type: FeeType.linear,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        params: rawParams('1000', '500'),
      };

      expect(shouldDeployNewFee(config, config)).to.equal(false);
    });

    it('requires redeploy when offchainQuotedLinear params change', () => {
      const actual: FeeArtifactConfig = {
        type: FeeType.offchainQuotedLinear,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        params: rawParams('1000', '500'),
        quoteSigners: ['0xsigner1'],
      };
      const expected: FeeArtifactConfig = {
        type: FeeType.offchainQuotedLinear,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        params: rawParams('2000', '500'),
        quoteSigners: ['0xsigner1'],
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
            params: rawParams('1000', '500'),
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
              params: rawParams('1000', '500'),
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
          params: rawParams('1000', '500'),
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
          params: rawParams('1000', '500'),
        },
        deployed: { address: '0xold' },
      };

      const expected: ArtifactNew<FeeArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          type: FeeType.regressive,
          owner: '0xowner',
          beneficiary: '0xbeneficiary',
          params: rawParams('1000', '500'),
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
              params: rawParams('1000', '500'),
            },
          },
        },
      };

      const result = mergeFeeArtifacts(current, expected);
      assert(
        result.artifactState === ArtifactState.DEPLOYED,
        'expected DEPLOYED',
      );
      expect(result.deployed.address).to.equal('0xexisting');
    });

    it('deploys new linear fee when params change', () => {
      const current: DeployedFeeArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: FeeType.linear,
          owner: '0xowner',
          beneficiary: '0xbeneficiary',
          params: rawParams('1000', '500'),
        },
        deployed: { address: '0xold' },
      };

      const expected: ArtifactNew<FeeArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          type: FeeType.linear,
          owner: '0xowner',
          beneficiary: '0xbeneficiary',
          params: rawParams('2000', '1000'),
        },
      };

      const result = mergeFeeArtifacts(current, expected);
      expect(result.artifactState).to.equal(ArtifactState.NEW);
    });
  });
});
