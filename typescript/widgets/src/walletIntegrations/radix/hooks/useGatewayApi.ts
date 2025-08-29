import { useContext } from 'react';

import { GatewayApiContext } from '../contexts.js';

export const useGatewayApi = () => useContext(GatewayApiContext);
