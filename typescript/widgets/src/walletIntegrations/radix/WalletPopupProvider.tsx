import React, { createContext, useContext, useState } from 'react';

import { SpinnerIcon } from '../../icons/Spinner.js';

const PopupContext = createContext<{
  showPopUp: boolean;
  setShowPopUp: React.Dispatch<React.SetStateAction<boolean>>;
} | null>(null);

export const PopupProvider = ({ children }) => {
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
