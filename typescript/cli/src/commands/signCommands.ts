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
  const commandPath = Array.isArray(argv._) ? argvPathToStrings(argv._) : [];

  // Check if it's a conditional command that only needs keys with --relay
  if (
    commandPath.some((segment) => CONDITIONAL_SIGN_COMMANDS.includes(segment))
  ) {
    return !!argv.relay;
  }

  return commandPath.some((segment) => SIGN_COMMANDS.includes(segment));
}

function argvPathToStrings(argvPath: unknown[]): string[] {
  return argvPath.map((segment) => String(segment));
}

export enum CommandType {
  WARP_DEPLOY = 'warp:deploy',
  WARP_READ = 'warp:read',
  WARP_SEND = 'warp:send',
  WARP_APPLY = 'warp:apply',
  WARP_CHECK = 'warp:check',
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
  ISM_DEPLOY = 'ism:deploy',
  ISM_READ = 'ism:read',
}
