import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import PropTypes from 'prop-types';
import React from 'react';

import { gatewayApiContext } from './contexts.js';

export const GatewayApiProvider = ({
  value,
  children,
}: {
  value: GatewayApiClient | null;
  children: React.ReactNode;
}) => (
  <gatewayApiContext.Provider value={value}>
    {children}
  </gatewayApiContext.Provider>
);

GatewayApiProvider.propTypes = {
  value: PropTypes.any,
  children: PropTypes.node.isRequired,
};
