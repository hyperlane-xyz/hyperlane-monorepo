// Commands that send tx and require a key to sign.
// It's useful to have this listed here so the context

// middleware can request keys up front when required.
export const SIGN_COMMANDS = [
  'apply',
  'deploy',
  'send',
  'submit',
  'relayer',
  'rebalancer',
];

// Commands that conditionally require keys based on flags
// (e.g., status only needs keys when --relay is passed)
export const CONDITIONAL_SIGN_COMMANDS = ['status'];

export function isSignCommand(argv: any): boolean {
  const command = argv._[0];
  const subCommand = argv._.length > 1 ? argv._[1] : undefined;

  // Check if it's a conditional command that only needs keys with --relay
  if (
    CONDITIONAL_SIGN_COMMANDS.includes(command) ||
    (subCommand && CONDITIONAL_SIGN_COMMANDS.includes(subCommand))
  ) {
    return !!argv.relay;
  }

  return !!(
    SIGN_COMMANDS.includes(command) ||
    (subCommand && SIGN_COMMANDS.includes(subCommand))
  );
}

export enum CommandType {
  WARP_DEPLOY = 'warp:deploy',
  WARP_READ = 'warp:read',
  WARP_SEND = 'warp:send',
  WARP_APPLY = 'warp:apply',
  WARP_REBALANCER = 'warp:rebalancer',
  SEND_MESSAGE = 'send:message',
  STATUS = 'status:',
  SUBMIT = 'submit:',
  RELAYER = 'relayer:',
  CORE_APPLY = 'core:apply',
  CORE_DEPLOY = 'core:deploy',
  CORE_READ = 'core:read',
  CORE_CHECK = 'core:check',
  ICA_DEPLOY = 'ica:deploy',
}
