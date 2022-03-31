export const ALL_ENVIRONMENTS = ['test'] as const;
type DeployEnvironmentTuple = typeof ALL_ENVIRONMENTS;
export type DeployEnvironment = DeployEnvironmentTuple[number];
