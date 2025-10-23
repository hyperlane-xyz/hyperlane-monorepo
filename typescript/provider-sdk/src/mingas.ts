export enum GasAction {
  CORE_DEPLOY_GAS = 'CORE_DEPLOY_GAS',
  WARP_DEPLOY_GAS = 'WARP_DEPLOY_GAS',
  TEST_SEND_GAS = 'TEST_SEND_GAS',
  AVS_GAS = 'AVS_GAS',
}

export type MinimumRequiredGasByAction = {
  [GasAction.CORE_DEPLOY_GAS]: bigint;
  [GasAction.WARP_DEPLOY_GAS]: bigint;
  [GasAction.TEST_SEND_GAS]: bigint;
  [GasAction.AVS_GAS]: bigint;
};
