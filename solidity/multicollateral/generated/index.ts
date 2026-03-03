/* eslint-disable */
/* THIS FILE IS AUTO-GENERATED. DO NOT EDIT DIRECTLY. */
import type { Abi } from 'viem';
import type { ArtifactEntry } from '@hyperlane-xyz/core';
import { MultiCollateralArtifact } from './contracts/MultiCollateral.js';
import { MultiCollateralRoutingFeeArtifact } from './contracts/MultiCollateralRoutingFee.js';
import { IMultiCollateralFeeArtifact } from './contracts/IMultiCollateralFee.js';
export * from './contracts/MultiCollateral.js';
export * from './contracts/MultiCollateralRoutingFee.js';
export * from './contracts/IMultiCollateralFee.js';

export const contractArtifacts: Record<string, ArtifactEntry<Abi>> = {
  "MultiCollateral": MultiCollateralArtifact,
  "MultiCollateralRoutingFee": MultiCollateralRoutingFeeArtifact,
  "IMultiCollateralFee": IMultiCollateralFeeArtifact,
};

export function getContractArtifactByName(
  name: string,
): ArtifactEntry<Abi> | undefined {
  return contractArtifacts[name];
}
