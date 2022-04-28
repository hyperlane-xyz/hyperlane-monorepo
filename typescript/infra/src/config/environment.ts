export enum ENVIRONMENTS_ENUM {
  Test = 'test',
  Dev = 'dev',
  Testnet = 'testnet',
}
export const ALL_ENVIRONMENTS = [
  ENVIRONMENTS_ENUM.Test,
  ENVIRONMENTS_ENUM.Dev,
  ENVIRONMENTS_ENUM.Testnet,
] as const;
type DeployEnvironmentTuple = typeof ALL_ENVIRONMENTS;
export type DeployEnvironment = DeployEnvironmentTuple[number];
