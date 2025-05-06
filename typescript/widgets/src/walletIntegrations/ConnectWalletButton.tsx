import { clsx } from 'clsx';
import React, { ButtonHTMLAttributes } from 'react';

import { ChainName, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType, shortenAddress } from '@hyperlane-xyz/utils';

import { Button } from '../components/Button.js';
import { ChevronIcon } from '../icons/Chevron.js';
import { WalletIcon } from '../icons/Wallet.js';
import { useIsSsr } from '../utils/ssr.js';

import { WalletLogo } from './WalletLogo.js';
import {
  getAddressFromAccountAndChain,
  useAccounts,
  useWalletDetails,
} from './multiProtocol.js';

type Props = {
  multiProvider: MultiProtocolProvider;
  onClickWhenConnected: () => void;
  onClickWhenUnconnected: () => void;
  countClassName?: string;
  chainName?: ChainName;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export function ConnectWalletButton({
  multiProvider,
  onClickWhenConnected,
  onClickWhenUnconnected,
  className,
  countClassName,
  chainName,
  ...rest
}: Props) {
  const isSsr = useIsSsr();

  const { readyAccounts } = useAccounts(multiProvider);
  const walletDetails = useWalletDetails();

  const numReady = readyAccounts.length;
  const firstAccount = readyAccounts[0];

  const shownAddress = shortenAddress(
    getAddressFromAccountAndChain(firstAccount, chainName),
    true,
  );

  const firstWallet =
    walletDetails[firstAccount?.protocol || ProtocolType.Ethereum];

  if (isSsr) {
    // https://github.com/wagmi-dev/wagmi/issues/542#issuecomment-1144178142
    return null;
  }

  return (
    <div className="htw-relative">
      <div className="htw-relative">
        {numReady === 0 && (
          <Button
            className={clsx('htw-py-2 htw-px-3', className)}
            onClick={onClickWhenUnconnected}
            title="Choose wallet"
            {...rest}
          >
            <div className="htw-flex htw-items-center htw-gap-2">
              <WalletIcon width={16} height={16} />
              <div className="htw-text-xs sm:htw-text-sm">Connect wallet</div>
            </div>
          </Button>
        )}

        {numReady === 1 && (
          <Button
            onClick={onClickWhenConnected}
            className={clsx('htw-px-2.5 htw-py-1', className)}
            {...rest}
          >
            <div className="htw-flex htw-w-36 htw-items-center htw-justify-center xs:htw-w-auto">
              <WalletLogo walletDetails={firstWallet} size={26} />
              <div className="htw-mx-3 htw-flex htw-flex-col htw-items-start">
                <div className="htw-text-xs htw-text-gray-500">
                  {firstWallet.name || 'Wallet'}
                </div>
                <div className="htw-text-xs">{shownAddress}</div>
              </div>
              <ChevronIcon direction="s" width={10} height={6} />
            </div>
          </Button>
        )}

        {numReady > 1 && (
          <Button
            onClick={onClickWhenConnected}
            className={clsx('htw-px-2.5 htw-py-1', className)}
            {...rest}
          >
            <div className="htw-flex htw-items-center htw-justify-center">
              <div
                style={{ height: 26, width: 26 }}
                className={clsx(
                  'htw-flex htw-items-center htw-justify-center htw-rounded-full htw-bg-gray-600 htw-text-white',
                  countClassName,
                )}
              >
                {numReady}
              </div>
              <div className="htw-mx-3 htw-flex htw-flex-col htw-items-start">
                <div className="htw-text-xs htw-text-gray-500">Wallets</div>
                <div className="htw-text-xs">{`${numReady} Connected`}</div>
              </div>
              <ChevronIcon direction="s" width={10} height={6} />
            </div>
          </Button>
        )}
      </div>
    </div>
  );
}
