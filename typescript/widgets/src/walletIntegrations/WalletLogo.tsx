import React from 'react';

import { WalletIcon } from '../icons/Wallet.js';
import { WalletConnectLogo } from '../logos/WalletConnect.js';

import { WalletDetails } from './types.js';

export function WalletLogo({
  walletDetails,
  size,
}: {
  walletDetails: WalletDetails;
  size?: number;
}) {
  const src = walletDetails.logoUrl?.trim();

  if (src) {
    return <img src={src} width={size} height={size} />;
  } else if (walletDetails.name?.toLowerCase() === 'walletconnect') {
    return <WalletConnectLogo width={size} height={size} />;
  } else {
    return <WalletIcon width={size} height={size} />;
  }
}
