// Commands that send tx and require a key to sign.
// It's useful to have this listed here so the context
import { ProtocolMap } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

// middleware can request keys up front when required.
export const SIGN_COMMANDS = [
  'apply',
  'deploy',
  'send',
  'status',
  'submit',
  'relayer',
  'rebalancer',
];

export function isSignCommand(argv: any): boolean {
  return (
    SIGN_COMMANDS.includes(argv._[0]) ||
    (argv._.length > 1 && SIGN_COMMANDS.includes(argv._[1]))
  );
}

export function isValidKey(key: string | ProtocolMap<string>): boolean {
  if (typeof key === 'string') {
    return true;
  } else if (Array.isArray(key)) {
    // if type if array it means the user inputted both --key.{protocol}
    // and the legacy flag --key at the same time
    return false;
  } else if (typeof key === 'object') {
    // if key is of type protocol map check if every provided protocol
    // is valid
    return Object.keys(key).every((protocol) =>
      Object.values<string>(ProtocolType).includes(protocol),
    );
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
