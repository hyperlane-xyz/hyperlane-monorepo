import React from 'react';

import { WalletIcon } from '../icons/Wallet.js';
import { BinanceLogo } from '../logos/Binance.js';
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
  const name = walletDetails.name?.toLowerCase();

  if (src) {
    return <img src={src} width={size} height={size} />;
  } else if (name === 'walletconnect') {
    return <WalletConnectLogo width={size} height={size} />;
  } else if (name === 'binance wallet') {
    return <BinanceLogo width={size} height={size} />;
  } else {
    return <WalletIcon width={size} height={size} />;
  }
}
