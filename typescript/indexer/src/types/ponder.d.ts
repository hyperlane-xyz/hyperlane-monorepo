/**
 * Stub type definitions for Ponder virtual modules.
 * Ponder generates these at runtime; these stubs allow tsc to pass.
 */

declare module 'ponder:registry' {
  export const ponder: {
    on: (event: string, handler: (args: any) => Promise<void>) => void;
  };
}

declare module 'ponder:schema' {
  export const indexedEvent: any;
}
