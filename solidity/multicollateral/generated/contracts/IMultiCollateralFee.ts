/* eslint-disable */
/* THIS FILE IS AUTO-GENERATED. DO NOT EDIT DIRECTLY. */
import type { Abi } from 'viem';
import type {
  ArtifactEntry,
  ContractMethodMap,
  RunnerLike,
  ViemContractLike,
} from '@hyperlane-xyz/core';
import { ViemContractFactory } from '@hyperlane-xyz/core';

export const IMultiCollateralFeeAbi = [
  {
    "type": "function",
    "name": "quoteTransferRemoteTo",
    "inputs": [
      {
        "name": "_destination",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "_recipient",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "_amount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "_targetRouter",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple[]",
        "internalType": "struct Quote[]",
        "components": [
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  }
] as const satisfies Abi;

export const IMultiCollateralFeeArtifact: ArtifactEntry<typeof IMultiCollateralFeeAbi> = {
  contractName: "IMultiCollateralFee",
  abi: IMultiCollateralFeeAbi,
  bytecode: "0x",
};

type IMultiCollateralFeeMethods = ContractMethodMap<typeof IMultiCollateralFeeAbi>;

type IMultiCollateralFeeEstimateGasMethods = {
  [TName in keyof IMultiCollateralFeeMethods]: ViemContractLike<typeof IMultiCollateralFeeAbi>['estimateGas'][TName];
};

export type IMultiCollateralFee = ViemContractLike<typeof IMultiCollateralFeeAbi> &
  IMultiCollateralFeeMethods & {
    estimateGas: ViemContractLike<typeof IMultiCollateralFeeAbi>['estimateGas'] &
      IMultiCollateralFeeEstimateGasMethods;
  };

export class IMultiCollateralFee__factory extends ViemContractFactory<typeof IMultiCollateralFeeAbi, IMultiCollateralFee> {
  static readonly artifact = IMultiCollateralFeeArtifact;

  static connect(address: string, runner?: RunnerLike): IMultiCollateralFee {
    return super.connect(address, runner) as IMultiCollateralFee;
  }
}
