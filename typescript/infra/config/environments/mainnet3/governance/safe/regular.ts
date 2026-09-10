import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

export const regularSafes: ChainMap<Address> = {
  // Regular Governance Safes
  arbitrum: '0x7379D7bB2ccA68982E467632B6554fD4e72e9431',
  base: '0x890ac177Fe3052B8676A65f32C1589Bc329f3d50',
  bsc: '0x7379D7bB2ccA68982E467632B6554fD4e72e9431',
  ethereum: '0x562Dfaac27A84be6C96273F5c9594DA1681C0DA7',
  optimism: '0x890ac177Fe3052B8676A65f32C1589Bc329f3d50',

  // ZKSync Governance Safes
  abstract: '0xcd81ccFe7D9306849136Fa96397113345a32ECf3',
  zksync: '0xcd81ccFe7D9306849136Fa96397113345a32ECf3',

  // Viction targets the Ethereum-controlled ICA in governance/ica/regular.ts.
  // The deployed Viction Safe is not the core governance owner.

  // Not in use after ICA 2.0 migration
  // berachain: '0x7379D7bB2ccA68982E467632B6554fD4e72e9431',
  // blast: '0x7379D7bB2ccA68982E467632B6554fD4e72e9431',
  // fraxtal: '0x890ac177Fe3052B8676A65f32C1589Bc329f3d50',
  // hyperevm: '0x290Eb7bbf939A36B2c350a668c04815E49757eDC',
  // linea: '0x7379D7bB2ccA68982E467632B6554fD4e72e9431',
  // mode: '0x7379D7bB2ccA68982E467632B6554fD4e72e9431',
  // sei: '0x7379D7bB2ccA68982E467632B6554fD4e72e9431',
  // taiko: '0x890ac177Fe3052B8676A65f32C1589Bc329f3d50',

  // Mar 12, 2026 - Igra Chain Deployment
  // ----------------------------------------------------------
  // igra: '0xb511a9046A1F9Df17E3CEC3Ff9d937071B986935',
};
