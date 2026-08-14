import { ValidatorBaseChainConfigMap } from '../../../src/config/agent/validator.js';
import { Contexts } from '../../contexts.js';
import { getReorgPeriod } from '../../registry.js';
import { validatorBaseConfigsFn } from '../utils.js';

import { environment } from './chains.js';

const AW_VALIDATOR = '0x3c659e0fe8d01b80d7828b421630085777346e7c';
const AW_RC_VALIDATOR = '0x3588e77a3a9bcaa92b2d9c6cd525697c6fdb2c76';
const AW_FASTPAH_VALIDATOR = '0x4b54641256233487c17ba76fba57a78b013dc5db';
const FASTPATH_VALIDATOR_REORG_PERIOD = 1;

export const fastPathReorgPeriodOverrides: Record<string, number> = {
  arbitrumsepolia: FASTPATH_VALIDATOR_REORG_PERIOD,
  basesepolia: FASTPATH_VALIDATOR_REORG_PERIOD,
  sepolia: FASTPATH_VALIDATOR_REORG_PERIOD,
};

export const validatorChainConfig = (
  context: Contexts,
): ValidatorBaseChainConfigMap => {
  const validatorsConfig = validatorBaseConfigsFn(environment, context);
  return {
    arbitrumsepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('arbitrumsepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
          [Contexts.FastPath]: [AW_FASTPAH_VALIDATOR],
        },
        'arbitrumsepolia',
      ),
    },
    basesepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('basesepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
          [Contexts.FastPath]: [AW_FASTPAH_VALIDATOR],
        },
        'basesepolia',
      ),
    },
    fuji: {
      interval: 5,
      reorgPeriod: getReorgPeriod('fuji'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
        },
        'fuji',
      ),
    },
    bsctestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('bsctestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
        },
        'bsctestnet',
      ),
    },
    sepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('sepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
          [Contexts.FastPath]: [AW_FASTPAH_VALIDATOR],
        },
        'sepolia',
      ),
    },
    optimismsepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('optimismsepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'optimismsepolia',
      ),
    },
    polygonamoy: {
      interval: 5,
      reorgPeriod: getReorgPeriod('polygonamoy'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'polygonamoy',
      ),
    },
    solanatestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('solanatestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'solanatestnet',
      ),
    },
    solanadevnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('solanadevnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'solanadevnet',
      ),
    },
    sonicsvmtestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('sonicsvmtestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'sonicsvmtestnet',
      ),
    },
    hyperliquidevmtestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('hyperliquidevmtestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'hyperliquidevmtestnet',
      ),
    },
    paradexsepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('paradexsepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'paradexsepolia',
      ),
    },
    starknetsepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('starknetsepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'starknetsepolia',
      ),
    },
    somniatestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('somniatestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'somniatestnet',
      ),
    },
    kyvetestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('kyvetestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'kyvetestnet',
      ),
    },
    modetestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('modetestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'modetestnet',
      ),
    },
    celestiatestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('celestiatestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'celestiatestnet',
      ),
    },
    celosepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('celosepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'celosepolia',
      ),
    },
    radixtestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('radixtestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'radixtestnet',
      ),
    },
    aleotestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('aleotestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'aleotestnet',
      ),
    },
    tronshasta: {
      interval: 5,
      reorgPeriod: getReorgPeriod('tronshasta'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'tronshasta',
      ),
    },
    seismictestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('seismictestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'seismictestnet',
      ),
    },
  };
};
