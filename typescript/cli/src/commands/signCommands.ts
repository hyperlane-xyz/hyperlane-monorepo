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
