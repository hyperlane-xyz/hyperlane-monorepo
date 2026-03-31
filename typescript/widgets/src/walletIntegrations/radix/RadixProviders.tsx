import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { RadixDappToolkit } from '@radixdlt/radix-dapp-toolkit';
import React, { useContext, useState } from 'react';

import { SpinnerIcon } from '../../icons/Spinner.js';

import { GatewayApiContext, PopupContext, RdtContext } from './contexts.js';

export const RdtProvider = ({
  value,
  children,
}: {
  value: RadixDappToolkit | null;
  children: React.ReactNode;
}) => <RdtContext.Provider value={value}>{children}</RdtContext.Provider>;

export const GatewayApiProvider = ({
  value,
  children,
}: {
  value: GatewayApiClient | null;
  children: React.ReactNode;
}) => (
  <GatewayApiContext.Provider value={value}>
    {children}
  </GatewayApiContext.Provider>
);

export const PopupProvider = ({ children }: { children: React.ReactNode }) => {
  const [showPopUp, setShowPopUp] = useState(false);

  return (
    <PopupContext.Provider value={{ showPopUp, setShowPopUp }}>
      {showPopUp && (
        <div className="RadixWalletPopupOverlay">
          <div className="RadixWalletPopup">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                fontWeight: 'bold',
              }}
            >
              <SpinnerIcon
                width={18}
                height={18}
                style={{ marginRight: '10px' }}
              />
              Login Request Pending
            </div>
            <div style={{ marginTop: '10px' }}>
              Open Your Radix Wallet App to complete the request
            </div>
            <button
              style={{ marginTop: '10px', textDecoration: 'underline' }}
              onClick={() => setShowPopUp(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {children}
    </PopupContext.Provider>
  );
};

export const usePopup = () => useContext(PopupContext);
