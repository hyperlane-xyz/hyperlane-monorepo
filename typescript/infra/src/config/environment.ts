export enum ENVIRONMENTS_ENUM {
  Test = 'test',
  Dev = 'dev',
};
export const ALL_ENVIRONMENTS = [ENVIRONMENTS_ENUM.Test, ENVIRONMENTS_ENUM.Dev] as const;
type DeployEnvironmentTuple = typeof ALL_ENVIRONMENTS;
export type DeployEnvironment = DeployEnvironmentTuple[number];
