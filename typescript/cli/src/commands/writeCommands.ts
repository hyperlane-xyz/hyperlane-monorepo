// Commands that send tx and require a key to sign.
// It's useful to have this listed here so the context
// middleware can request keys up front when required.
export const WRITE_COMMANDS = ['deploy', 'send'];
