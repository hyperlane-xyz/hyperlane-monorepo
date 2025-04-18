import { ChainMap, TokenStandard, WarpCoreConfig } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const MULTICALL3_ABI = `[{"inputs":[{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call[]","name":"calls","type":"tuple[]"}],"name":"aggregate","outputs":[{"internalType":"uint256","name":"blockNumber","type":"uint256"},{"internalType":"bytes[]","name":"returnData","type":"bytes[]"}],"stateMutability":"payable","type":"function"},{"inputs":[{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bool","name":"allowFailure","type":"bool"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call3[]","name":"calls","type":"tuple[]"}],"name":"aggregate3","outputs":[{"components":[{"internalType":"bool","name":"success","type":"bool"},{"internalType":"bytes","name":"returnData","type":"bytes"}],"internalType":"struct Multicall3.Result[]","name":"returnData","type":"tuple[]"}],"stateMutability":"payable","type":"function"},{"inputs":[{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bool","name":"allowFailure","type":"bool"},{"internalType":"uint256","name":"value","type":"uint256"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call3Value[]","name":"calls","type":"tuple[]"}],"name":"aggregate3Value","outputs":[{"components":[{"internalType":"bool","name":"success","type":"bool"},{"internalType":"bytes","name":"returnData","type":"bytes"}],"internalType":"struct Multicall3.Result[]","name":"returnData","type":"tuple[]"}],"stateMutability":"payable","type":"function"},{"inputs":[{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call[]","name":"calls","type":"tuple[]"}],"name":"blockAndAggregate","outputs":[{"internalType":"uint256","name":"blockNumber","type":"uint256"},{"internalType":"bytes32","name":"blockHash","type":"bytes32"},{"components":[{"internalType":"bool","name":"success","type":"bool"},{"internalType":"bytes","name":"returnData","type":"bytes"}],"internalType":"struct Multicall3.Result[]","name":"returnData","type":"tuple[]"}],"stateMutability":"payable","type":"function"},{"inputs":[],"name":"getBasefee","outputs":[{"internalType":"uint256","name":"basefee","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"blockNumber","type":"uint256"}],"name":"getBlockHash","outputs":[{"internalType":"bytes32","name":"blockHash","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getBlockNumber","outputs":[{"internalType":"uint256","name":"blockNumber","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getChainId","outputs":[{"internalType":"uint256","name":"chainid","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getCurrentBlockCoinbase","outputs":[{"internalType":"address","name":"coinbase","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getCurrentBlockDifficulty","outputs":[{"internalType":"uint256","name":"difficulty","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getCurrentBlockGasLimit","outputs":[{"internalType":"uint256","name":"gaslimit","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getCurrentBlockTimestamp","outputs":[{"internalType":"uint256","name":"timestamp","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"addr","type":"address"}],"name":"getEthBalance","outputs":[{"internalType":"uint256","name":"balance","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getLastBlockHash","outputs":[{"internalType":"bytes32","name":"blockHash","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bool","name":"requireSuccess","type":"bool"},{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call[]","name":"calls","type":"tuple[]"}],"name":"tryAggregate","outputs":[{"components":[{"internalType":"bool","name":"success","type":"bool"},{"internalType":"bytes","name":"returnData","type":"bytes"}],"internalType":"struct Multicall3.Result[]","name":"returnData","type":"tuple[]"}],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"bool","name":"requireSuccess","type":"bool"},{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call[]","name":"calls","type":"tuple[]"}],"name":"tryBlockAndAggregate","outputs":[{"internalType":"uint256","name":"blockNumber","type":"uint256"},{"internalType":"bytes32","name":"blockHash","type":"bytes32"},{"components":[{"internalType":"bool","name":"success","type":"bool"},{"internalType":"bytes","name":"returnData","type":"bytes"}],"internalType":"struct Multicall3.Result[]","name":"returnData","type":"tuple[]"}],"stateMutability":"payable","type":"function"}]`;

export const MILLENNIUM_FALCON_ADDRESS: ChainMap<Address> = {
  bsctestnet: '0x6205f14fb059921A4EF1CE76EbfC747de67AbDE6',
  basesepolia: '0x8a01602EdF9D81e89132eaFAB02b5C9f644bC975',
  optimismsepolia: '0x83543eF801a296153347890Db9de60E2D114aCDb',
  arbitrumsepolia: '0x8912456C2b678EA42c259140674839BdAda8326d',
  sepolia: '0x403f6B09C1C634F9C4Ce0cCa8da4b6EC22A4ff53',
};
export const MILLENNIUM_FALCON_ABI = `[{"inputs":[{"components":[{"internalType":"uint32","name":"destination","type":"uint32"},{"internalType":"bytes32","name":"recipient","type":"bytes32"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"uint256","name":"value","type":"uint256"}],"internalType":"struct MillenniumFalcon.TransferCall[]","name":"calls","type":"tuple[]"}],"name":"punchIt","outputs":[],"stateMutability":"payable","type":"function"}]`;

export const KESSEL_RUN_FUNDER_CONFIG = {
  owner: '0xB282Db526832b160144Fc712fccEBC8ceFd9d19a',
  relayer: '0xf2c72c0befa494d62949a1699a99e2c605a0b636',
  vanguard0: '0x2c9209efcaff2778d945e18fb24174e16845dc62',
  vanguard1: '0x939043d9db00f6ada1b742239beb7ddd5bf82096',
  vanguard2: '0x45b58e4d46a89c003cc7126bd971eb3794a66aeb',
  vanguard3: '0x1f4fdb150e8c9fda70687a2fd481e305af1e7f8e',
  vanguard4: '0xe41b227e7aaaf7bbd1d60258de0dd76a11a0c3fc',
} as const;

// rc-testnet4-key-kesselrunner-validator-0
export const KESSEL_RUN_OWNER_CONFIG = {
  owner: KESSEL_RUN_FUNDER_CONFIG.owner,
};

export const KESSEL_RUN_ENV = 'testnet4';
export const KESSEL_RUN_TARGET_NETWORKS = [
  'basesepolia',
  'arbitrumsepolia',
  'sepolia',
  'bsctestnet',
  'optimismsepolia',
];

export const KESSEL_RUN_HOURLY_RATE = 250000;

export const KESSEL_RUN_CONFIG: {
  bursts: number;
  burstInterval: number;
  distArbOp: ChainMap<number>;
  distBaseBscEth: ChainMap<number>;
  distro: ChainMap<number>;
  multicallBatchSize: number;
} = {
  bursts: 120,
  burstInterval: 5, // seconds
  distArbOp: {
    arbitrumsepolia: 0.02,
    basesepolia: 0.23,
    bsctestnet: 0.23,
    optimismsepolia: 0.02,
    sepolia: 0.5,
  },
  distBaseBscEth: {
    arbitrumsepolia: 0.02,
    basesepolia: 0.02,
    bsctestnet: 0.02,
    optimismsepolia: 0.02,
    sepolia: 0.02,
  },
  distro: {
    arbitrumsepolia: 0.34,
    basesepolia: 0.38,
    bsctestnet: 0.08,
    optimismsepolia: 0.06,
    sepolia: 0.14,
  },
  multicallBatchSize: 100,
};

export const KESSEL_RUN_SPICE_ROUTE: WarpCoreConfig = {
  tokens: [
    {
      chainName: 'bsctestnet',
      standard: TokenStandard.EvmHypSynthetic,
      decimals: 18,
      symbol: 'SPICE',
      name: 'Spice',
      addressOrDenom: '0x975B8Cf9501cBaD717812fcdE3b51a390AD77540',
      connections: [
        {
          token:
            'ethereum|basesepolia|0x4Cd2d5deD9D1ef5013fddCDceBeaCB32DFb5ad47',
        },
        {
          token:
            'ethereum|optimismsepolia|0x554B0724432Ef42CB4a2C12E756F6F022e37aD8F',
        },
        {
          token:
            'ethereum|arbitrumsepolia|0xdED2d823A5e4E82AfbBB68A3e9D947eE03EFbA9d',
        },
        {
          token: 'ethereum|sepolia|0x51BB50884Ec21063DEC3DCA0B2d4aCeF2559E65a',
        },
      ],
    },
    {
      chainName: 'basesepolia',
      standard: TokenStandard.EvmHypSynthetic,
      decimals: 18,
      symbol: 'SPICE',
      name: 'Spice',
      addressOrDenom: '0x4Cd2d5deD9D1ef5013fddCDceBeaCB32DFb5ad47',
      connections: [
        {
          token:
            'ethereum|bsctestnet|0x975B8Cf9501cBaD717812fcdE3b51a390AD77540',
        },
        {
          token:
            'ethereum|optimismsepolia|0x554B0724432Ef42CB4a2C12E756F6F022e37aD8F',
        },
        {
          token:
            'ethereum|arbitrumsepolia|0xdED2d823A5e4E82AfbBB68A3e9D947eE03EFbA9d',
        },
        {
          token: 'ethereum|sepolia|0x51BB50884Ec21063DEC3DCA0B2d4aCeF2559E65a',
        },
      ],
    },
    {
      chainName: 'optimismsepolia',
      standard: TokenStandard.EvmHypSynthetic,
      decimals: 18,
      symbol: 'SPICE',
      name: 'Spice',
      addressOrDenom: '0x554B0724432Ef42CB4a2C12E756F6F022e37aD8F',
      connections: [
        {
          token:
            'ethereum|bsctestnet|0x975B8Cf9501cBaD717812fcdE3b51a390AD77540',
        },
        {
          token:
            'ethereum|basesepolia|0x4Cd2d5deD9D1ef5013fddCDceBeaCB32DFb5ad47',
        },
        {
          token:
            'ethereum|arbitrumsepolia|0xdED2d823A5e4E82AfbBB68A3e9D947eE03EFbA9d',
        },
        {
          token: 'ethereum|sepolia|0x51BB50884Ec21063DEC3DCA0B2d4aCeF2559E65a',
        },
      ],
    },
    {
      chainName: 'arbitrumsepolia',
      standard: TokenStandard.EvmHypSynthetic,
      decimals: 18,
      symbol: 'SPICE',
      name: 'Spice',
      addressOrDenom: '0xdED2d823A5e4E82AfbBB68A3e9D947eE03EFbA9d',
      connections: [
        {
          token:
            'ethereum|bsctestnet|0x975B8Cf9501cBaD717812fcdE3b51a390AD77540',
        },
        {
          token:
            'ethereum|basesepolia|0x4Cd2d5deD9D1ef5013fddCDceBeaCB32DFb5ad47',
        },
        {
          token:
            'ethereum|optimismsepolia|0x554B0724432Ef42CB4a2C12E756F6F022e37aD8F',
        },
        {
          token: 'ethereum|sepolia|0x51BB50884Ec21063DEC3DCA0B2d4aCeF2559E65a',
        },
      ],
    },
    {
      chainName: 'sepolia',
      standard: TokenStandard.EvmHypSynthetic,
      decimals: 18,
      symbol: 'SPICE',
      name: 'Spice',
      addressOrDenom: '0x51BB50884Ec21063DEC3DCA0B2d4aCeF2559E65a',
      connections: [
        {
          token:
            'ethereum|bsctestnet|0x975B8Cf9501cBaD717812fcdE3b51a390AD77540',
        },
        {
          token:
            'ethereum|basesepolia|0x4Cd2d5deD9D1ef5013fddCDceBeaCB32DFb5ad47',
        },
        {
          token:
            'ethereum|optimismsepolia|0x554B0724432Ef42CB4a2C12E756F6F022e37aD8F',
        },
        {
          token:
            'ethereum|arbitrumsepolia|0xdED2d823A5e4E82AfbBB68A3e9D947eE03EFbA9d',
        },
      ],
    },
  ],
};
