import type { Connector } from '@starknet-react/core';

// starknetkit@3.4.3's root declaration re-exports `./main` without a file
// extension, which NodeNext cannot resolve. Keep this augmentation narrow and
// aligned with the hook surface used by widgets until upstream fixes it.
declare module 'starknetkit' {
  interface StarknetkitConnectModalOptions {
    connectors: Connector[];
  }

  interface StarknetkitConnectModalResult {
    connector: Connector | null;
  }

  export function useStarknetkitConnectModal(
    options: StarknetkitConnectModalOptions,
  ): {
    starknetkitConnectModal: () => Promise<StarknetkitConnectModalResult>;
  };
}
