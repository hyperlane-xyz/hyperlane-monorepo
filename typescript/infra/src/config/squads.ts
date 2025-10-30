import { PublicKey } from '@solana/web3.js';

import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

export type SquadConfig = {
  programId: Address;
  multisigPda: Address;
  vault: Address;
};

export type SquadsKeys = Record<keyof SquadConfig, PublicKey>;

export const squadsConfigs: ChainMap<SquadConfig> = {
  solanamainnet: {
    programId: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',
    multisigPda: 'EvptYJrjGUB3FXDoW8w8LTpwg1TTS4W1f628c1BnscB4',
    vault: '3oocunLfAgATEqoRyW7A5zirsQuHJh6YjD4kReiVVKLa',
  },
  soon: {
    programId: 'Hz8Zg8JYFshThnKHXSZV9XJFbyYUUKBb5NJUrxDvF8PB',
    multisigPda: '3tQm2hkauvqoRsfJg6NmUA6eMEWqFdvbiJUZUBFHXD6A',
    vault: '7Y6WDpMfNeb1b4YYbyUkF41z1DuPhvDDuWWJCHPRNa9Y',
  },
  eclipsemainnet: {
    programId: 'eSQDSMLf3qxwHVHeTr9amVAGmZbRLY2rFdSURandt6f',
    multisigPda: 'CSnrKeqrrLm6v9NvChYKT58mfRGYnMk8MeLGWhKvBdbk',
    vault: 'D742EWw9wpV47jRAvEenG1oWHfMmpiQNJLjHTBfXhuRm',
  },
  sonicsvm: {
    programId: 'sqdsFBUUwbsuoLUhoWdw343Je6mvn7dGVVRYCa4wtqJ',
    multisigPda: 'BsdNMofu1a4ncHFJSNZWuTcZae9yt4ZGDuaneN5am5m6',
    vault: '8ECSwp5yo2EeZkozSrpPnMj5Rmcwa4VBYCETE9LHmc9y',
  },
  solaxy: {
    programId: '222DRw2LbM7xztYq1efxcbfBePi6xnv27o7QBGm9bpts',
    multisigPda: 'XgeE3uXEy5bKPbgYv3D9pWovhu3PWrxt3RR5bdp9RkW',
    vault: '4chV16Dea6CW6xyQcHj9RPwBZitfxYgpafkSoZgzy4G8',
  },
  // svmbnb: {
  //   programId: 'Hz8Zg8JYFshThnKHXSZV9XJFbyYUUKBb5NJUrxDvF8PB',
  //   multisigPda: '9eQpT28rq83sc2wtsGK7TYirXJ4sL1QmQENSMz2TbHEv',
  //   vault: '3JiYeSX1rN2nsh78Xqypg87vQd2Y5Y9h5w9ns6Hjii5B',
  // },
};

export function getSquadsKeys(chainName: ChainName): SquadsKeys {
  if (!squadsConfigs[chainName]) {
    throw new Error(`Squads config not found on chain ${chainName}`);
  }
  return {
    multisigPda: new PublicKey(squadsConfigs[chainName].multisigPda),
    programId: new PublicKey(squadsConfigs[chainName].programId),
    vault: new PublicKey(squadsConfigs[chainName].vault),
  };
}
