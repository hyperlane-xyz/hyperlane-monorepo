import { expect } from 'chai';
import { BigNumber, constants, utils } from 'ethers';

import {
  decodeLayerZeroV2AppExecutorConfig,
  decodeLayerZeroV2AppUlnConfig,
  decodeLayerZeroV2EffectiveExecutorConfig,
  decodeLayerZeroV2EffectiveUlnConfig,
  encodeLayerZeroV2ExecutorConfig,
  encodeLayerZeroV2UlnConfig,
  layerZeroV2ReceiveConfigParams,
  layerZeroV2SendConfigParams,
} from './configCodec.js';
import { LayerZeroV2ConfigMode } from './types.js';

const EXECUTOR_CONFIG_TYPE =
  'tuple(uint32 maxMessageSize,address executor)' as const;
const ULN_CONFIG_TYPE =
  'tuple(uint64 confirmations,uint8 requiredDVNCount,uint8 optionalDVNCount,uint8 optionalDVNThreshold,address[] requiredDVNs,address[] optionalDVNs)' as const;
const executor = '0x0000000000000000000000000000000000000001';
const dvnA = '0x0000000000000000000000000000000000000002';
const dvnB = '0x0000000000000000000000000000000000000003';

function decodeAppUln(encoded: string) {
  const [config] = utils.defaultAbiCoder.decode([ULN_CONFIG_TYPE], encoded);
  return decodeLayerZeroV2AppUlnConfig(
    config.confirmations,
    config.requiredDVNCount,
    config.optionalDVNCount,
    config.optionalDVNThreshold,
    config.requiredDVNs,
    config.optionalDVNs,
  );
}

describe('LayerZero V2 config codec', () => {
  it('round-trips default and partial executor configs', () => {
    const defaultEncoded = encodeLayerZeroV2ExecutorConfig({
      type: LayerZeroV2ConfigMode.Default,
    });
    const [defaultConfig] = utils.defaultAbiCoder.decode(
      [EXECUTOR_CONFIG_TYPE],
      defaultEncoded,
    );
    expect(
      decodeLayerZeroV2AppExecutorConfig(
        Number(defaultConfig.maxMessageSize),
        defaultConfig.executor,
      ),
    ).to.deep.equal({ type: LayerZeroV2ConfigMode.Default });

    const override = {
      type: LayerZeroV2ConfigMode.Override,
      executor,
    } as const;
    const [encodedOverride] = utils.defaultAbiCoder.decode(
      [EXECUTOR_CONFIG_TYPE],
      encodeLayerZeroV2ExecutorConfig(override),
    );
    expect(
      decodeLayerZeroV2AppExecutorConfig(
        Number(encodedOverride.maxMessageSize),
        encodedOverride.executor,
      ),
    ).to.deep.equal(override);
  });

  it('round-trips inherited, literal-zero, and explicit-empty ULN fields', () => {
    expect(
      decodeAppUln(
        encodeLayerZeroV2UlnConfig({
          type: LayerZeroV2ConfigMode.Default,
        }),
      ),
    ).to.deep.equal({ type: LayerZeroV2ConfigMode.Default });

    const override = {
      type: 'override' as const,
      confirmations: 0n,
      requiredDVNs: [],
      optionalDVNs: [dvnA, dvnB],
      optionalDVNThreshold: 1,
    };
    expect(decodeAppUln(encodeLayerZeroV2UlnConfig(override))).to.deep.equal(
      override,
    );

    const [encoded] = utils.defaultAbiCoder.decode(
      [ULN_CONFIG_TYPE],
      encodeLayerZeroV2UlnConfig(override),
    );
    expect(encoded.confirmations).to.deep.equal(
      BigNumber.from(2).pow(64).sub(1),
    );
    expect(encoded.requiredDVNCount).to.equal(255);

    const largeConfirmations = (1n << 64n) - 2n;
    expect(
      decodeAppUln(
        encodeLayerZeroV2UlnConfig({
          type: LayerZeroV2ConfigMode.Override,
          confirmations: largeConfirmations,
        }),
      ),
    ).to.deep.equal({
      type: LayerZeroV2ConfigMode.Override,
      confirmations: largeConfirmations,
    });
  });

  it('decodes effective values separately from app overrides', () => {
    const effectiveExecutor = utils.defaultAbiCoder.encode(
      [EXECUTOR_CONFIG_TYPE],
      [{ maxMessageSize: 10_000, executor }],
    );
    expect(
      decodeLayerZeroV2EffectiveExecutorConfig(effectiveExecutor),
    ).to.deep.equal({ maxMessageSize: 10_000, executor });

    const effectiveUln = utils.defaultAbiCoder.encode(
      [ULN_CONFIG_TYPE],
      [
        {
          confirmations: 12,
          requiredDVNCount: 1,
          optionalDVNCount: 1,
          optionalDVNThreshold: 1,
          requiredDVNs: [dvnA],
          optionalDVNs: [dvnB],
        },
      ],
    );
    expect(decodeLayerZeroV2EffectiveUlnConfig(effectiveUln)).to.deep.equal({
      confirmations: 12n,
      requiredDVNs: [dvnA],
      optionalDVNs: [dvnB],
      optionalDVNThreshold: 1,
    });
  });

  it('omits inherited configs from enrollment params', () => {
    expect(
      layerZeroV2SendConfigParams({
        executor: { type: LayerZeroV2ConfigMode.Default },
        uln: { type: LayerZeroV2ConfigMode.Default },
      }),
    ).to.deep.equal([]);
    expect(
      layerZeroV2ReceiveConfigParams({
        uln: { type: LayerZeroV2ConfigMode.Default },
      }),
    ).to.deep.equal([]);
  });

  it('rejects malformed raw app config', () => {
    expect(() =>
      decodeLayerZeroV2AppUlnConfig(12, 2, 0, 0, [dvnA], []),
    ).to.throw('does not match');
    expect(() => decodeLayerZeroV2AppUlnConfig(0, 0, 0, 1, [], [])).to.throw(
      'must be 0',
    );
    expect(() =>
      decodeLayerZeroV2AppUlnConfig(0, 0, 0, 0, [dvnA], []),
    ).to.throw('uses DEFAULT');
    expect(() =>
      decodeLayerZeroV2AppExecutorConfig(0, constants.AddressZero),
    ).not.to.throw();
  });

  it('rejects malformed effective ULN config', () => {
    const malformed = utils.defaultAbiCoder.encode(
      [ULN_CONFIG_TYPE],
      [
        {
          confirmations: 12,
          requiredDVNCount: 2,
          optionalDVNCount: 0,
          optionalDVNThreshold: 0,
          requiredDVNs: [dvnA],
          optionalDVNs: [],
        },
      ],
    );
    expect(() => decodeLayerZeroV2EffectiveUlnConfig(malformed)).to.throw(
      'does not match',
    );
  });
});
