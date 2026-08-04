import { ValidatorBaseChainConfigMap } from '../../../src/config/agent/validator.js';
import { Contexts } from '../../contexts.js';
import { getReorgPeriod } from '../../registry.js';
import { validatorBaseConfigsFn } from '../utils.js';

import { environment } from './chains.js';

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
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'arbitrumsepolia',
      ),
    },
    basesepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('basesepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'basesepolia',
      ),
    },
    fuji: {
      interval: 5,
      reorgPeriod: getReorgPeriod('fuji'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
          [Contexts.ReleaseCandidate]: [
            '0xfc419f9ba3c56c55e28844ade491d428f5a77d55',
          ],
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
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
          [Contexts.ReleaseCandidate]: [
            '0x6353c7402626054c824bd0eca721f82b725e2b4d',
          ],
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
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
          [Contexts.ReleaseCandidate]: [
            '0x49f253c0dab33be1573d6c2769b3d9e584d91f82',
          ],
          [Contexts.Neutron]: [],
        },
        'sepolia',
      ),
    },
    optimismsepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('optimismsepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
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
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
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
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
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
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
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
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
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
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
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
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
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
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
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
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
        },
        'somniatestnet',
      ),
    },
    cotitestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('cotitestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
        },
        'cotitestnet',
      ),
    },
    kyvetestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('kyvetestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
        },
        'kyvetestnet',
      ),
    },
    modetestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('modetestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
        },
        'modetestnet',
      ),
    },
    celestiatestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('celestiatestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
        },
        'celestiatestnet',
      ),
    },
    celosepolia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('celosepolia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
        },
        'celosepolia',
      ),
    },
    radixtestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('radixtestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
        },
        'radixtestnet',
      ),
    },
    aleotestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('aleotestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
        },
        'aleotestnet',
      ),
    },
    tronshasta: {
      interval: 5,
      reorgPeriod: getReorgPeriod('tronshasta'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
        },
        'tronshasta',
      ),
    },
    seismictestnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('seismictestnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: ['0x3c659e0fe8d01b80d7828b421630085777346e7c'],
        },
        'seismictestnet',
      ),
    },
  };
};
