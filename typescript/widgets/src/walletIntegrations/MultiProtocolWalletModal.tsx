import React, { PropsWithChildren } from 'react';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { Modal } from '../layout/Modal.js';
import { PROTOCOL_TO_LOGO } from '../logos/protocols.js';

import { useConnectFns } from './multiProtocol.js';

export function MultiProtocolWalletModal({
  isOpen,
  close,
  protocols,
}: {
  isOpen: boolean;
  close: () => void;
  protocols?: ProtocolType[]; // defaults to all protocols if not provided
}) {
  const connectFns = useConnectFns();

  const onClickProtocol = (protocol: ProtocolType) => {
    close();
    const connectFn = connectFns[protocol];
    if (connectFn) connectFn();
  };

  const includesProtocol = (protocol: ProtocolType) =>
    !protocols || protocols.includes(protocol);

  return (
    <Modal isOpen={isOpen} close={close} panelClassname="htw-max-w-sm htw-p-4">
      <div className="htw-flex htw-flex-col htw-space-y-2.5 htw-pb-2 htw-pt-4">
        {includesProtocol(ProtocolType.Ethereum) && (
          <ProtocolButton
            protocol={ProtocolType.Ethereum}
            onClick={onClickProtocol}
            subTitle="an EVM"
          >
            Ethereum
          </ProtocolButton>
        )}
        {includesProtocol(ProtocolType.Sealevel) && (
          <ProtocolButton
            protocol={ProtocolType.Sealevel}
            onClick={onClickProtocol}
            subTitle="a Solana"
          >
            Solana
          </ProtocolButton>
        )}
        {includesProtocol(ProtocolType.Cosmos) && (
          <ProtocolButton
            protocol={ProtocolType.Cosmos}
            onClick={onClickProtocol}
            subTitle="a Cosmos"
          >
            Cosmos
          </ProtocolButton>
        )}
        {includesProtocol(ProtocolType.Starknet) && (
          <ProtocolButton
            protocol={ProtocolType.Starknet}
            onClick={onClickProtocol}
            subTitle="a Starknet"
          >
            Starknet
          </ProtocolButton>
        )}
      </div>
    </Modal>
  );
}

function ProtocolButton({
  onClick,
  subTitle,
  protocol,
  children,
}: PropsWithChildren<{
  subTitle: string;
  protocol: ProtocolType;
  onClick: (protocol: ProtocolType) => void;
}>) {
  const Logo = PROTOCOL_TO_LOGO[protocol];
  return (
    <button
      onClick={() => onClick(protocol)}
      className="htw-flex htw-w-full htw-flex-col htw-items-center htw-space-y-2.5 htw-rounded-lg htw-border htw-border-gray-200 htw-py-3.5 htw-transition-all hover:htw-bg-gray-100 active:htw-scale-95"
    >
      <Logo width={34} height={34} />
      <div className="htw-tracking-wide htw-text-gray-800">{children}</div>
      <div className="htw-text-sm htw-text-gray-500">{`Connect to ${subTitle} compatible wallet`}</div>
    </button>
  );
}
