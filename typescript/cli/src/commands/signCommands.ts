// Commands that send tx and require a key to sign.
// It's useful to have this listed here so the context
// middleware can request keys up front when required.
export const SIGN_COMMANDS = [
  'apply',
  'deploy',
  'send',
  'status',
  'submit',
  'relayer',
];

export function isSignCommand(argv: any): boolean {
  return (
    SIGN_COMMANDS.includes(argv._[0]) ||
    (argv._.length > 1 && SIGN_COMMANDS.includes(argv._[1]))
  );
}

export enum CommandType {
  WARP_DEPLOY = 'warp:deploy',
  WARP_SEND = 'warp:send',
  WARP_APPLY = 'warp:apply',
  SEND_MESSAGE = 'send:message',
  AGENT_KURTOSIS = 'deploy:kurtosis-agents',
  STATUS = 'status:',
  SUBMIT = 'submit:',
  RELAYER = 'relayer:',
  CORE_APPLY = 'core:apply',
}
