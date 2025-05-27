// Commands that send tx and require a key to sign.
// It's useful to have this listed here so the context
import { ChainMap } from '@hyperlane-xyz/sdk';

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

export function isValidKey(key: string | ChainMap<string>): boolean {
  if (typeof key === 'string') {
    return true;
  } else if (Array.isArray(key)) {
    // if type if array it means the user inputed both --key.{chain_name}
    // and the legacy flag --key at the same time
    return false;
  } else if (typeof key === 'object') {
    return true;
  } else {
    return false;
  }
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
  CORE_DEPLOY = 'core:deploy',
}
