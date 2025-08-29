import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { RadixDappToolkit } from '@radixdlt/radix-dapp-toolkit';
import { createContext } from 'react';

export const gatewayApiContext = createContext<GatewayApiClient | null>(null);
export const RdtContext = createContext<RadixDappToolkit | null>(null);
