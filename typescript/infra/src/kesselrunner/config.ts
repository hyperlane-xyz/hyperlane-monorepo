import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const MULTICALL3_ABI = `[{"inputs":[{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call[]","name":"calls","type":"tuple[]"}],"name":"aggregate","outputs":[{"internalType":"uint256","name":"blockNumber","type":"uint256"},{"internalType":"bytes[]","name":"returnData","type":"bytes[]"}],"stateMutability":"payable","type":"function"},{"inputs":[{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bool","name":"allowFailure","type":"bool"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call3[]","name":"calls","type":"tuple[]"}],"name":"aggregate3","outputs":[{"components":[{"internalType":"bool","name":"success","type":"bool"},{"internalType":"bytes","name":"returnData","type":"bytes"}],"internalType":"struct Multicall3.Result[]","name":"returnData","type":"tuple[]"}],"stateMutability":"payable","type":"function"},{"inputs":[{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bool","name":"allowFailure","type":"bool"},{"internalType":"uint256","name":"value","type":"uint256"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call3Value[]","name":"calls","type":"tuple[]"}],"name":"aggregate3Value","outputs":[{"components":[{"internalType":"bool","name":"success","type":"bool"},{"internalType":"bytes","name":"returnData","type":"bytes"}],"internalType":"struct Multicall3.Result[]","name":"returnData","type":"tuple[]"}],"stateMutability":"payable","type":"function"},{"inputs":[{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call[]","name":"calls","type":"tuple[]"}],"name":"blockAndAggregate","outputs":[{"internalType":"uint256","name":"blockNumber","type":"uint256"},{"internalType":"bytes32","name":"blockHash","type":"bytes32"},{"components":[{"internalType":"bool","name":"success","type":"bool"},{"internalType":"bytes","name":"returnData","type":"bytes"}],"internalType":"struct Multicall3.Result[]","name":"returnData","type":"tuple[]"}],"stateMutability":"payable","type":"function"},{"inputs":[],"name":"getBasefee","outputs":[{"internalType":"uint256","name":"basefee","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"blockNumber","type":"uint256"}],"name":"getBlockHash","outputs":[{"internalType":"bytes32","name":"blockHash","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getBlockNumber","outputs":[{"internalType":"uint256","name":"blockNumber","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getChainId","outputs":[{"internalType":"uint256","name":"chainid","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getCurrentBlockCoinbase","outputs":[{"internalType":"address","name":"coinbase","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getCurrentBlockDifficulty","outputs":[{"internalType":"uint256","name":"difficulty","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getCurrentBlockGasLimit","outputs":[{"internalType":"uint256","name":"gaslimit","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getCurrentBlockTimestamp","outputs":[{"internalType":"uint256","name":"timestamp","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"addr","type":"address"}],"name":"getEthBalance","outputs":[{"internalType":"uint256","name":"balance","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getLastBlockHash","outputs":[{"internalType":"bytes32","name":"blockHash","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bool","name":"requireSuccess","type":"bool"},{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call[]","name":"calls","type":"tuple[]"}],"name":"tryAggregate","outputs":[{"components":[{"internalType":"bool","name":"success","type":"bool"},{"internalType":"bytes","name":"returnData","type":"bytes"}],"internalType":"struct Multicall3.Result[]","name":"returnData","type":"tuple[]"}],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"bool","name":"requireSuccess","type":"bool"},{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call[]","name":"calls","type":"tuple[]"}],"name":"tryBlockAndAggregate","outputs":[{"internalType":"uint256","name":"blockNumber","type":"uint256"},{"internalType":"bytes32","name":"blockHash","type":"bytes32"},{"components":[{"internalType":"bool","name":"success","type":"bool"},{"internalType":"bytes","name":"returnData","type":"bytes"}],"internalType":"struct Multicall3.Result[]","name":"returnData","type":"tuple[]"}],"stateMutability":"payable","type":"function"}]`;

export const MILLENNIUM_FALCON_ADDRESS: ChainMap<Address> = {
  // bsctestnet: '0x6205f14fb059921A4EF1CE76EbfC747de67AbDE6',
  // basesepolia: '0x8a01602EdF9D81e89132eaFAB02b5C9f644bC975',
  // optimismsepolia: '0x83543eF801a296153347890Db9de60E2D114aCDb',
  // arbitrumsepolia: '0x8912456C2b678EA42c259140674839BdAda8326d',
  // sepolia: '0x403f6B09C1C634F9C4Ce0cCa8da4b6EC22A4ff53',

  bsc: '0xeD0560D7C96e380e82BdC8Cb5692B2cAE7E4AAA0',
  base: '0xeD0560D7C96e380e82BdC8Cb5692B2cAE7E4AAA0',
  optimism: '0xeD0560D7C96e380e82BdC8Cb5692B2cAE7E4AAA0',
  arbitrum: '0xeD0560D7C96e380e82BdC8Cb5692B2cAE7E4AAA0',
  ethereum: '0xeD0560D7C96e380e82BdC8Cb5692B2cAE7E4AAA0',
};
export const MILLENNIUM_FALCON_ABI = `[{"inputs":[{"components":[{"internalType":"uint32","name":"destination","type":"uint32"},{"internalType":"bytes32","name":"recipient","type":"bytes32"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"uint256","name":"value","type":"uint256"}],"internalType":"struct MillenniumFalcon.TransferCall[]","name":"calls","type":"tuple[]"}],"name":"punchIt","outputs":[],"stateMutability":"payable","type":"function"}]`;

export const KESSEL_RUN_FUNDER_CONFIG = {
  owner: '0xB282Db526832b160144Fc712fccEBC8ceFd9d19a',
  // vanguard0: '0xbe2e6b1ce045422a08a3662fffa3fc5f114efc3d',
  // vanguard1: '0xdbcd22e5223f5d0040398e66dbb525308f27c655',
  // vanguard2: '0x226b721316ea44aad50a10f4cc67fc30658ab4a9',
  // vanguard3: '0xcdd728647ecd9d75413c9b780de303b1d1eb12a5',
  // vanguard4: '0x5401627b69f317da9adf3d6e1e1214724ce49032',
  // vanguard5: '0x6fd953d1cbdf3a79663b4238898147a6cf36d459',

  vanguard0: '0xbe2e6b1ce045422a08a3662fffa3fc5f114efc3d',
  vanguard1: '0xdbcd22e5223f5d0040398e66dbb525308f27c655',
  vanguard2: '0x226b721316ea44aad50a10f4cc67fc30658ab4a9',
  vanguard3: '0xcdd728647ecd9d75413c9b780de303b1d1eb12a5',
  vanguard4: '0x5401627b69f317da9adf3d6e1e1214724ce49032',
  vanguard5: '0x6fd953d1cbdf3a79663b4238898147a6cf36d459',
} as const;

// rc-testnet4-key-kesselrunner-validator-0
export const KESSEL_RUN_OWNER_CONFIG = {
  owner: KESSEL_RUN_FUNDER_CONFIG.owner,
};

export const KESSEL_RUN_ENV = 'mainnet3';
export const KESSEL_RUN_TARGET_NETWORKS = [
  // 'basesepolia',
  // 'arbitrumsepolia',
  // 'sepolia',
  // 'bsctestnet',
  // 'optimismsepolia',
  'base',
  'arbitrum',
  'ethereum',
  'bsc',
  'optimism',
];

export const KESSEL_RUN_HOURLY_RATE = 25000;

export const KESSEL_RUN_CONFIG: {
  bursts: number;
  burstInterval: number;
  distArbOp: ChainMap<number>;
  distBaseBscEth: ChainMap<number>;
  distro: ChainMap<number>;
  multicallBatchSize: number;
} = {
  bursts: 60,
  burstInterval: 5, // seconds
  // distArbOp: {
  //   arbitrumsepolia: 0.02,
  //   basesepolia: 0.23,
  //   bsctestnet: 0.23,
  //   optimismsepolia: 0.02,
  //   sepolia: 0.5,
  // },
  // distBaseBscEth: {
  //   arbitrumsepolia: 0.02,
  //   basesepolia: 0.02,
  //   bsctestnet: 0.02,
  //   optimismsepolia: 0.02,
  //   sepolia: 0.02,
  // },
  // distro: {
  //   arbitrumsepolia: 0.34,
  //   basesepolia: 0.38,
  //   bsctestnet: 0.08,
  //   optimismsepolia: 0.06,
  //   sepolia: 0.14,
  // },
  distArbOp: {
    arbitrum: 0.02,
    base: 0.23,
    bsc: 0.23,
    optimism: 0.02,
    ethereum: 0.5,
  },
  distBaseBscEth: {
    arbitrum: 0.02,
    base: 0.02,
    bsc: 0.02,
    optimism: 0.02,
    ethereum: 0.02,
  },
  distro: {
    arbitrum: 0.34,
    base: 0.38,
    bsc: 0.08,
    optimism: 0.06,
    ethereum: 0.14,
  },
  multicallBatchSize: 100,
};

export const KESSEL_RUN_SPICE_ROUTE: ChainMap<Address> = {
  // bsctestnet: '0x975B8Cf9501cBaD717812fcdE3b51a390AD77540',
  // basesepolia: '0x4Cd2d5deD9D1ef5013fddCDceBeaCB32DFb5ad47',
  // optimismsepolia: '0x554B0724432Ef42CB4a2C12E756F6F022e37aD8F',
  // arbitrumsepolia: '0xdED2d823A5e4E82AfbBB68A3e9D947eE03EFbA9d',
  // sepolia: '0x51BB50884Ec21063DEC3DCA0B2d4aCeF2559E65a',
  bsc: '0x9537c772c6092DB4B93cFBA93659bB5a8c0E133D',
  base: '0x830B15a1986C75EaF8e048442a13715693CBD8bD',
  optimism: '0x31cD131F5F6e1Cc0d6743F695Fc023B70D0aeAd8',
  arbitrum: '0xF80dcED2488Add147E60561F8137338F7f3976e1',
  ethereum: '0xC10c27afcb915439C27cAe54F5F46Da48cd71190',
};
