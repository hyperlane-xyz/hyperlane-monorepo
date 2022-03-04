import { BigNumberish } from 'ethers';
import { ChainName } from './chain';
import { DeployEnvironment } from '../deploy';

export type ChainConfig {
  name: string;
  domain: number;
  signer: ethers.Signer,
  overrides?: ethers.Overrides,
  confirmations?: number;
};

type Address = string;

export type ProxiedAddress = {
  proxy: Address;
  implementation: Address;
  beacon: Address;
};

export type CoreContractAddresses = {
  upgradeBeaconController: Address;
  xAppConnectionManager: Address;
  validatorManager: Address;
  governanceRouter: ProxiedAddress;
  outbox: ProxiedAddress;
  inboxes: Record<number, ProxiedAddress>;
};

export type CoreConfig = {
  processGas: BigNumberish;
  reserveGas: BigNumberish;
  validators: Record<number, Address>;
}
