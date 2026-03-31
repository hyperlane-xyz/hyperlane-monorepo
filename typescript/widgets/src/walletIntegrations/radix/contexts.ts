import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { RadixDappToolkit } from '@radixdlt/radix-dapp-toolkit';
import { createContext } from 'react';

export const GatewayApiContext = createContext<GatewayApiClient | null>(null);
export const RdtContext = createContext<RadixDappToolkit | null>(null);
export const PopupContext = createContext<{
  showPopUp: boolean;
  setShowPopUp: React.Dispatch<React.SetStateAction<boolean>>;
} | null>(null);
