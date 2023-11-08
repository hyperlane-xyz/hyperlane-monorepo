// import { ChainName, GasOracleContractType, HookType, MerkleTreeHookConfig } from "@hyperlane-xyz/sdk";

// const presetHookConfigs = (owner: Address, destinationChains: ChainName[]) => {

//     const gasOracleType: ChainMap<GasOracleContractType> = destinationChains.reduce((acc, chain) => {
//         acc[chain] = GasOracleContractType.StorageGasOracle;
//         return acc;
//     }
//     const gasOverhead =
//     return  {
//         type: HookType.AGGREGATION,
//         hooks: [
//             {
//                 type: HookType.MERKLE_TREE,
//             } as MerkleTreeHookConfig,
//             {
//                 type: HookType.INTERCHAIN_GAS_PAYMASTER,
//                 owner: owner,
//                 beneficiary: owner,
//                 gasOracleType,

//                 oracleKey: owner,
//             }
//         ]
//     }
// }
