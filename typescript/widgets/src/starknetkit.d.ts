declare module 'starknetkit' {
  export interface StarknetkitConnector {
    id: string;
    name: string;
    icon?: string | { light: string; dark: string };
  }

  export interface StarknetkitConnectModalOptions {
    connectors: StarknetkitConnector[];
  }

  export interface StarknetkitConnectModalResult {
    connector?: any;
  }

  export function useStarknetkitConnectModal(
    options: StarknetkitConnectModalOptions,
  ): {
    starknetkitConnectModal: () => Promise<StarknetkitConnectModalResult>;
  };
}
