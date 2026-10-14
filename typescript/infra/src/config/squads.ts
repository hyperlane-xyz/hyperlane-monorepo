import { PublicKey } from '@solana/web3.js';

import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { GovernanceType } from '../governanceTypes.js';

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
};

export const abacusWorksSquadsConfigs: ChainMap<SquadConfig> = {
  solanamainnet: {
    programId: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',
    multisigPda: 'BjKsMZUxVovbzZf3uZjdhorE1YqAtvD7yKF2E8wv2cje',
    vault: 'BNGDJ1h9brgt6FFVd8No1TVAH48Fp44d7jkuydr1URwJ',
  },
  eclipsemainnet: {
    programId: 'eSQDSMLf3qxwHVHeTr9amVAGmZbRLY2rFdSURandt6f',
    multisigPda: 'EC5f1WufYD5SHXyH5XEAy8Ud66eh88N1MuekpQJuVpV6',
    vault: 'E4TncCw3WMqQZbkACVcomX3HqcSzLfNyhTnqKN1DimGr',
  },
};

const SQUADS_CONFIGS: Partial<Record<GovernanceType, ChainMap<SquadConfig>>> = {
  [GovernanceType.AbacusWorks]: abacusWorksSquadsConfigs,
  [GovernanceType.Regular]: squadsConfigs,
};

export function getSquadsConfig(
  chainName: ChainName,
  governanceType: GovernanceType = GovernanceType.Regular,
): SquadConfig | undefined {
  return SQUADS_CONFIGS[governanceType]?.[chainName];
}

export function getSquadsKeys(
  chainName: ChainName,
  governanceType: GovernanceType = GovernanceType.Regular,
): SquadsKeys {
  const config = getSquadsConfig(chainName, governanceType);
  if (!config) {
    throw new Error(
      `Squads config not found on chain ${chainName} for governance type ${governanceType}`,
    );
  }
  return {
    multisigPda: new PublicKey(config.multisigPda),
    programId: new PublicKey(config.programId),
    vault: new PublicKey(config.vault),
  };
}
