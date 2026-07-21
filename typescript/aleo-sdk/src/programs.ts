export const ALEO_PROGRAMS = [
  'credits',
  'dispatch_proxy',
  'hook_manager',
  'hyp_collateral',
  'hyp_native',
  'hyp_synthetic',
  'ism_manager',
  'mailbox',
  'token_registry',
  'validator_announce',
] as const;

export type AleoProgram = (typeof ALEO_PROGRAMS)[number];
