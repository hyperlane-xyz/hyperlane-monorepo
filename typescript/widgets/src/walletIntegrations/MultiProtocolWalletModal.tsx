import React, { PropsWithChildren } from 'react';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { Modal } from '../layout/Modal.js';
import { PROTOCOL_TO_LOGO } from '../logos/protocols.js';

import { useConnectFns } from './multiProtocol.js';

export function MultiProtocolWalletModal({
  isOpen,
  close,
}: {
  isOpen: boolean;
  close: () => void;
}) {
  const connectFns = useConnectFns();

  const onClickProtocol = (protocol: ProtocolType) => {
    close();
    const connectFn = connectFns[protocol];
    if (connectFn) connectFn();
  };

  return (
    <Modal
      title="Select Wallet Type"
      isOpen={isOpen}
      close={close}
      panelClassname="htw-max-w-sm"
    >
      <div className="flex flex-col space-y-2.5 pb-2 pt-4">
        <ProtocolButton
          protocol={ProtocolType.Ethereum}
          onClick={onClickProtocol}
          subTitle="an EVM"
        >
          Ethereum
        </ProtocolButton>
        <ProtocolButton
          protocol={ProtocolType.Sealevel}
          onClick={onClickProtocol}
          subTitle="a Solana"
        >
          Solana
        </ProtocolButton>
        <ProtocolButton
          protocol={ProtocolType.Cosmos}
          onClick={onClickProtocol}
          subTitle="a Cosmos"
        >
          Cosmos
        </ProtocolButton>
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
      className="flex w-full flex-col items-center space-y-2.5 rounded-lg border border-gray-200 py-3.5 transition-all hover:border-gray-200 hover:bg-gray-100 active:bg-gray-200"
    >
      <Logo width={34} height={34} />
      <div className="tracking-wide text-gray-800">{children}</div>
      <div className="text-sm text-gray-500">{`Connect to ${subTitle} compatible wallet`}</div>
    </button>
  );
}
