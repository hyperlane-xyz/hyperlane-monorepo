import { useContext } from 'react';

import { gatewayApiContext } from '../contexts.js';

export const useGatewayApi = () => useContext(gatewayApiContext);
