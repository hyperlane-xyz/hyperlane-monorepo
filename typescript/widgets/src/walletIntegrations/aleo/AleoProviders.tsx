import { Network } from '@provablehq/aleo-types';
import { WalletDecryptPermission } from '@provablehq/aleo-wallet-standard';
import React, { useContext, useEffect, useState } from 'react';

import { Modal } from '../../layout/Modal.js';

import { AleoPopupContext } from './contexts.js';
import { getAdapter } from './utils.js';

export const AleoPopupProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [showPopUp, setShowPopUp] = useState(false);
  const [walletDetails, setWalletDetails] = useState<{
    name: string;
    icon: string;
  } | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const adapterInstance = getAdapter();
      setWalletDetails({
        name: adapterInstance.name,
        icon: adapterInstance.icon,
      });
    }
  }, []);

  const handleWalletClick = async () => {
    setShowPopUp(false);

    const adapter = getAdapter();

    // Check if wallet is installed by checking if the provider is available
    if (!adapter.readyState || adapter.readyState === 'NotDetected') {
      // Wallet not installed, open Chrome Web Store
      window.open(
        'https://chromewebstore.google.com/detail/shield/hhddpjpacfjaakjioinajgmhlbhfchao?utm_source=hyperlane&utm_medium=nexus',
        '_blank',
      );
      return;
    }

    // Wallet is installed, proceed with connection
    await adapter.connect(
      Network.MAINNET,
      WalletDecryptPermission.AutoDecrypt,
      [],
    );
  };

  return (
    <AleoPopupContext.Provider value={{ showPopUp, setShowPopUp }}>
      <Modal
        isOpen={showPopUp}
        close={() => setShowPopUp(false)}
        title="Connect with an Aleo Wallet"
        showCloseButton={true}
        panelClassname="htw-max-w-sm htw-p-4"
      >
        <div className="htw-flex htw-flex-col htw-space-y-2.5 htw-pb-2 htw-pt-4">
          <button
            onClick={handleWalletClick}
            className="htw-flex htw-w-full htw-flex-col htw-items-center htw-space-y-2.5 htw-rounded-lg htw-border htw-border-gray-200 htw-py-3.5 htw-transition-all hover:htw-bg-gray-100 active:htw-scale-95"
          >
            {walletDetails?.icon && (
              <img
                src={walletDetails.icon}
                alt={walletDetails.name}
                width={34}
                height={34}
              />
            )}
            <div className="htw-tracking-wide htw-text-gray-800">
              {walletDetails?.name || 'Shield Wallet'}
            </div>
          </button>
        </div>
      </Modal>
      {children}
    </AleoPopupContext.Provider>
  );
};

export const useAleoPopup = () => useContext(AleoPopupContext);
