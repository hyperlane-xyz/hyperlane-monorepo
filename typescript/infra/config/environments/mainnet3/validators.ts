import { assert, objMap } from '@hyperlane-xyz/utils';

import { ValidatorBaseChainConfigMap } from '../../../src/config/agent/validator.js';
import { isEthereumProtocolChain } from '../../../src/utils/utils.js';
import { Contexts } from '../../contexts.js';
import { getReorgPeriod } from '../../registry.js';
import { validatorBaseConfigsFn } from '../utils.js';

import { environment } from './chains.js';
import { AW_FASTPATH_VALIDATOR } from './fastpath/validators.js';

const AW_VALIDATOR = '0xa5962efa3ec138bf7ca8f7fde86b7ee32e24bf03';
const AW_RC_VALIDATOR = '0xf2028e9b93249c4a4310aeefae5c60d4915725af';
const DEFAULT_VALIDATOR_INTERVAL = 5;
// Preserve about one-second average checkpoint polling delay while halving
// steady-state polling relative to the original 1-second cadence.
const FASTPATH_VALIDATOR_INTERVAL = 2;
const FASTPATH_VALIDATOR_REORG_PERIOD = 1;
// bsc (PoSA) and polygon (PoS) have a history of multi-block reorgs, so they
// use a small non-zero reorg period instead of 1 even on the fast path.
const FASTPATH_REORG_PRONE_REORG_PERIOD = 3;
export const fastPathReorgPeriodOverrides: Record<string, number> = {
  arbitrum: FASTPATH_VALIDATOR_REORG_PERIOD,
  base: FASTPATH_VALIDATOR_REORG_PERIOD,
  bsc: FASTPATH_REORG_PRONE_REORG_PERIOD,
  citrea: FASTPATH_VALIDATOR_REORG_PERIOD,
  ethereum: FASTPATH_VALIDATOR_REORG_PERIOD,
  katana: FASTPATH_VALIDATOR_REORG_PERIOD,
  polygon: FASTPATH_REORG_PRONE_REORG_PERIOD,
};

const validatorInterval = (context: Contexts) =>
  context === Contexts.FastPath
    ? FASTPATH_VALIDATOR_INTERVAL
    : DEFAULT_VALIDATOR_INTERVAL;

const validatorReorgPeriod = (
  context: Contexts,
  chain: Parameters<typeof getReorgPeriod>[0],
) => {
  const defaultReorgPeriod = getReorgPeriod(chain);

  if (context !== Contexts.FastPath) {
    return defaultReorgPeriod;
  }

  // Fail loud rather than silently falling back to the conservative default:
  // a fastpath validator chain without an override would otherwise lose its
  // intended low-finality setting.
  const fastPathReorgPeriod = fastPathReorgPeriodOverrides[chain];
  assert(
    fastPathReorgPeriod !== undefined,
    `Missing fastpath reorgPeriod override for chain ${chain}`,
  );
  return fastPathReorgPeriod;
};

export const validatorChainConfig = (
  context: Contexts,
): ValidatorBaseChainConfigMap => {
  const validatorsConfig = validatorBaseConfigsFn(environment, context);
  const configs: ValidatorBaseChainConfigMap = {
    celo: {
      interval: 5,
      reorgPeriod: getReorgPeriod('celo'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
        },
        'celo',
      ),
    },
    ethereum: {
      interval: validatorInterval(context),
      reorgPeriod: validatorReorgPeriod(context, 'ethereum'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
          [Contexts.FastPath]: [AW_FASTPATH_VALIDATOR],
        },
        'ethereum',
      ),
    },
    avalanche: {
      interval: 5,
      reorgPeriod: getReorgPeriod('avalanche'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
        },
        'avalanche',
      ),
    },
    worldchain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('worldchain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
        },
        'worldchain',
      ),
    },
    xlayer: {
      interval: 5,
      reorgPeriod: getReorgPeriod('xlayer'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
        },
        'xlayer',
      ),
    },
    polygon: {
      interval: validatorInterval(context),
      reorgPeriod: validatorReorgPeriod(context, 'polygon'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
          [Contexts.FastPath]: [AW_FASTPATH_VALIDATOR],
        },
        'polygon',
      ),
    },
    bsc: {
      interval: validatorInterval(context),
      reorgPeriod: validatorReorgPeriod(context, 'bsc'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
          [Contexts.FastPath]: [AW_FASTPATH_VALIDATOR],
        },
        'bsc',
      ),
    },
    arbitrum: {
      interval: validatorInterval(context),
      reorgPeriod: validatorReorgPeriod(context, 'arbitrum'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
          [Contexts.FastPath]: [AW_FASTPATH_VALIDATOR],
        },
        'arbitrum',
      ),
    },
    optimism: {
      interval: 5,
      reorgPeriod: getReorgPeriod('optimism'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
        },
        'optimism',
      ),
    },
    gnosis: {
      interval: 5,
      reorgPeriod: getReorgPeriod('gnosis'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
        },
        'gnosis',
      ),
    },
    base: {
      interval: validatorInterval(context),
      reorgPeriod: validatorReorgPeriod(context, 'base'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
          [Contexts.FastPath]: [AW_FASTPATH_VALIDATOR],
        },
        'base',
      ),
    },
    bob: {
      interval: 5,
      reorgPeriod: getReorgPeriod('bob'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'bob',
      ),
    },
    fraxtal: {
      interval: 5,
      reorgPeriod: getReorgPeriod('fraxtal'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
        },
        'fraxtal',
      ),
    },
    linea: {
      interval: 5,
      reorgPeriod: getReorgPeriod('linea'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
        },
        'linea',
      ),
    },
    mantle: {
      interval: 5,
      reorgPeriod: getReorgPeriod('mantle'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'mantle',
      ),
    },
    sei: {
      interval: 5,
      reorgPeriod: getReorgPeriod('sei'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
        },
        'sei',
      ),
    },
    solanamainnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('solanamainnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'solanamainnet',
      ),
    },
    eclipsemainnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('eclipsemainnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'eclipsemainnet',
      ),
    },
    taiko: {
      interval: 5,
      reorgPeriod: getReorgPeriod('taiko'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [],
          [Contexts.Neutron]: [],
        },
        'taiko',
      ),
    },
    paradex: {
      interval: 5,
      reorgPeriod: getReorgPeriod('paradex'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'paradex',
      ),
    },
    viction: {
      interval: 5,
      reorgPeriod: getReorgPeriod('viction'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
        },
        'viction',
      ),
    },
    blast: {
      interval: 5,
      reorgPeriod: getReorgPeriod('blast'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
        },
        'blast',
      ),
    },
    mode: {
      interval: 5,
      reorgPeriod: getReorgPeriod('mode'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
          [Contexts.Neutron]: [],
        },
        'mode',
      ),
    },
    lisk: {
      interval: 5,
      reorgPeriod: getReorgPeriod('lisk'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'lisk',
      ),
    },
    lukso: {
      interval: 5,
      reorgPeriod: getReorgPeriod('lukso'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'lukso',
      ),
    },
    metis: {
      interval: 5,
      reorgPeriod: getReorgPeriod('metis'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'metis',
      ),
    },
    bitlayer: {
      interval: 5,
      reorgPeriod: getReorgPeriod('bitlayer'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'bitlayer',
      ),
    },
    oortmainnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('oortmainnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [''],
          [Contexts.Neutron]: [],
        },
        'oortmainnet',
      ),
    },
    zksync: {
      interval: 5,
      reorgPeriod: getReorgPeriod('zksync'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'zksync',
      ),
    },
    apechain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('apechain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'apechain',
      ),
    },
    morph: {
      interval: 5,
      reorgPeriod: getReorgPeriod('morph'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'morph',
      ),
    },
    flowmainnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('flowmainnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'flowmainnet',
      ),
    },
    immutablezkevmmainnet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('immutablezkevmmainnet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'immutablezkevmmainnet',
      ),
    },
    metal: {
      interval: 5,
      reorgPeriod: getReorgPeriod('metal'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'metal',
      ),
    },
    prom: {
      interval: 5,
      reorgPeriod: getReorgPeriod('prom'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'prom',
      ),
    },
    boba: {
      interval: 5,
      reorgPeriod: getReorgPeriod('boba'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'boba',
      ),
    },
    superseed: {
      interval: 5,
      reorgPeriod: getReorgPeriod('superseed'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'superseed',
      ),
    },
    unichain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('unichain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'unichain',
      ),
    },
    vana: {
      interval: 5,
      reorgPeriod: getReorgPeriod('vana'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'vana',
      ),
    },
    bsquared: {
      interval: 5,
      reorgPeriod: getReorgPeriod('bsquared'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'bsquared',
      ),
    },
    lumiaprism: {
      interval: 5,
      reorgPeriod: getReorgPeriod('lumiaprism'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'lumiaprism',
      ),
    },
    appchain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('appchain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'appchain',
      ),
    },
    ink: {
      interval: 5,
      reorgPeriod: getReorgPeriod('ink'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'ink',
      ),
    },
    soneium: {
      interval: 5,
      reorgPeriod: getReorgPeriod('soneium'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'soneium',
      ),
    },
    sonic: {
      interval: 5,
      reorgPeriod: getReorgPeriod('sonic'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'sonic',
      ),
    },
    soon: {
      interval: 5,
      reorgPeriod: getReorgPeriod('soon'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'soon',
      ),
    },
    hemi: {
      interval: 5,
      reorgPeriod: getReorgPeriod('hemi'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'hemi',
      ),
    },
    abstract: {
      interval: 5,
      reorgPeriod: getReorgPeriod('abstract'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'abstract',
      ),
    },
    matchain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('matchain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'matchain',
      ),
    },
    sonicsvm: {
      interval: 5,
      reorgPeriod: getReorgPeriod('sonicsvm'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'sonicsvm',
      ),
    },
    berachain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('berachain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'berachain',
      ),
    },
    arcadia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('arcadia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'arcadia',
      ),
    },
    ronin: {
      interval: 5,
      reorgPeriod: getReorgPeriod('ronin'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'ronin',
      ),
    },
    starknet: {
      interval: 5,
      reorgPeriod: getReorgPeriod('starknet'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'starknet',
      ),
    },
    subtensor: {
      interval: 5,
      reorgPeriod: getReorgPeriod('subtensor'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'subtensor',
      ),
    },
    hyperevm: {
      interval: 5,
      reorgPeriod: getReorgPeriod('hyperevm'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.ReleaseCandidate]: [AW_RC_VALIDATOR],
        },
        'hyperevm',
      ),
    },
    plume: {
      interval: 5,
      reorgPeriod: getReorgPeriod('plume'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'plume',
      ),
    },
    coti: {
      interval: 5,
      reorgPeriod: getReorgPeriod('coti'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'coti',
      ),
    },
    nibiru: {
      interval: 5,
      reorgPeriod: getReorgPeriod('nibiru'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'nibiru',
      ),
    },
    reactive: {
      interval: 5,
      reorgPeriod: getReorgPeriod('reactive'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'reactive',
      ),
    },
    hashkey: {
      interval: 5,
      reorgPeriod: getReorgPeriod('hashkey'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'hashkey',
      ),
    },
    peaq: {
      interval: 5,
      reorgPeriod: getReorgPeriod('peaq'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'peaq',
      ),
    },
    kyve: {
      interval: 5,
      reorgPeriod: getReorgPeriod('kyve'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'kyve',
      ),
    },
    botanix: {
      interval: 5,
      reorgPeriod: getReorgPeriod('botanix'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'botanix',
      ),
    },
    katana: {
      interval: validatorInterval(context),
      reorgPeriod: validatorReorgPeriod(context, 'katana'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.FastPath]: [AW_FASTPATH_VALIDATOR],
        },
        'katana',
      ),
    },
    solaxy: {
      interval: 5,
      reorgPeriod: getReorgPeriod('solaxy'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'solaxy',
      ),
    },
    tac: {
      interval: 5,
      reorgPeriod: getReorgPeriod('tac'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'tac',
      ),
    },
    galactica: {
      interval: 5,
      reorgPeriod: getReorgPeriod('galactica'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'galactica',
      ),
    },
    noble: {
      interval: 5,
      reorgPeriod: getReorgPeriod('noble'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'noble',
      ),
    },
    celestia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('celestia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'celestia',
      ),
    },
    mitosis: {
      interval: 5,
      reorgPeriod: getReorgPeriod('mitosis'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'mitosis',
      ),
    },
    radix: {
      interval: 5,
      reorgPeriod: getReorgPeriod('radix'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'radix',
      ),
    },
    pulsechain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('pulsechain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'pulsechain',
      ),
    },
    plasma: {
      interval: 5,
      reorgPeriod: getReorgPeriod('plasma'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'plasma',
      ),
    },
    electroneum: {
      interval: 5,
      reorgPeriod: getReorgPeriod('electroneum'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'electroneum',
      ),
    },
    zerogravity: {
      interval: 5,
      reorgPeriod: getReorgPeriod('zerogravity'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'zerogravity',
      ),
    },
    mantra: {
      interval: 5,
      reorgPeriod: getReorgPeriod('mantra'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'mantra',
      ),
    },
    carrchain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('carrchain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'carrchain',
      ),
    },
    monad: {
      interval: 5,
      reorgPeriod: getReorgPeriod('monad'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'monad',
      ),
    },
    somnia: {
      interval: 5,
      reorgPeriod: getReorgPeriod('somnia'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'somnia',
      ),
    },
    lazai: {
      interval: 5,
      reorgPeriod: getReorgPeriod('lazai'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'lazai',
      ),
    },
    megaeth: {
      interval: 5,
      reorgPeriod: getReorgPeriod('megaeth'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'megaeth',
      ),
    },
    adichain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('adichain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'adichain',
      ),
    },
    stable: {
      interval: 5,
      reorgPeriod: getReorgPeriod('stable'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'stable',
      ),
    },
    aleo: {
      interval: 5,
      reorgPeriod: getReorgPeriod('aleo'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'aleo',
      ),
    },
    citrea: {
      interval: validatorInterval(context),
      reorgPeriod: validatorReorgPeriod(context, 'citrea'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
          [Contexts.FastPath]: [AW_FASTPATH_VALIDATOR],
        },
        'citrea',
      ),
    },
    eni: {
      interval: 5,
      reorgPeriod: getReorgPeriod('eni'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'eni',
      ),
    },
    krown: {
      interval: 5,
      reorgPeriod: getReorgPeriod('krown'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'krown',
      ),
    },
    eden: {
      interval: 5,
      reorgPeriod: getReorgPeriod('eden'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'eden',
      ),
    },
    igra: {
      interval: 5,
      reorgPeriod: getReorgPeriod('igra'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'igra',
      ),
    },
    tron: {
      interval: 5,
      reorgPeriod: getReorgPeriod('tron'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'tron',
      ),
    },
    mocachain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('mocachain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'mocachain',
      ),
    },
    fluent: {
      interval: 5,
      reorgPeriod: getReorgPeriod('fluent'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'fluent',
      ),
    },
    kiichain: {
      interval: 5,
      reorgPeriod: getReorgPeriod('kiichain'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'kiichain',
      ),
    },
    nesa: {
      interval: 5,
      reorgPeriod: getReorgPeriod('nesa'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'nesa',
      ),
    },
    nexus: {
      interval: 5,
      reorgPeriod: getReorgPeriod('nexus'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'nexus',
      ),
    },
    robinhood: {
      interval: 5,
      reorgPeriod: getReorgPeriod('robinhood'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'robinhood',
      ),
    },
    tea: {
      interval: 5,
      reorgPeriod: getReorgPeriod('tea'),
      validators: validatorsConfig(
        {
          [Contexts.Hyperlane]: [AW_VALIDATOR],
        },
        'tea',
      ),
    },
  };

  // Opt-in quorum RPC verification (ValidatorMultiRpcQuorumMerkleTreeHook) for
  // every EVM chain's Hyperlane and FastPath validators. ReleaseCandidate/Neutron
  // validator sets are unaffected.
  if (context !== Contexts.Hyperlane && context !== Contexts.FastPath) {
    return configs;
  }
  return objMap(configs, (chain, config) =>
    isEthereumProtocolChain(chain)
      ? { ...config, quorumVerificationEnabled: true }
      : config,
  );
};
