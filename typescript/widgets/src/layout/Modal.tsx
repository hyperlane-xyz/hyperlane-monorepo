import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
} from '@headlessui/react';
import clsx from 'clsx';
import React, { ComponentProps, PropsWithChildren, useState } from 'react';

import { IconButton } from '../components/IconButton.js';
import { XCircleIcon } from '../icons/XCircle.js';

export function useModal() {
  const [isOpen, setIsOpen] = useState(false);
  const open = () => setIsOpen(true);
  const close = () => setIsOpen(false);
  return { isOpen, open, close };
}

export type ModalProps = PropsWithChildren<{
  isOpen: boolean;
  close: () => void;
  dialogClassname?: string;
  dialogProps?: ComponentProps<typeof Dialog>;
  panelClassname?: string;
  panelProps?: ComponentProps<typeof DialogPanel>;
  showCloseButton?: boolean;
  title?: string;
}>;

export function Modal({
  isOpen,
  close,
  dialogClassname,
  dialogProps,
  panelClassname,
  panelProps,
  showCloseButton,
  title,
  children,
}: ModalProps) {
  return (
    <Dialog
      open={isOpen}
      as="div"
      className={clsx('htw-z-20 htw-focus:outline-none', dialogClassname)}
      onClose={close}
      {...dialogProps}
    >
      <DialogBackdrop className="htw-fixed htw-inset-0 htw-bg-black/25 htw-transition-all htw-duration-200" />
      <div className="htw-fixed htw-inset-0 htw-z-20 htw-w-screen htw-overflow-y-auto">
        <div className="htw-flex htw-min-h-full htw-items-center htw-justify-center htw-p-4">
          <DialogPanel
            transition
            className={clsx(
              'htw-w-full htw-max-w-sm htw-max-h-[90vh] htw-relative htw-rounded-lg htw-shadow htw-overflow-auto no-scrollbar htw-bg-white htw-duration-200 htw-ease-out data-[closed]:htw-transform-[scale(95%)] data-[closed]:htw-opacity-0 data-[closed]:htw--translate-y-1',
              panelClassname,
            )}
            {...panelProps}
          >
            {title && (
              <DialogTitle as="h3" className="htw-text-gray-700">
                {title}
              </DialogTitle>
            )}
            {children}
            {showCloseButton && (
              <div className="htw-absolute htw-right-3 htw-top-3">
                <IconButton
                  onClick={close}
                  title="Close"
                  className="hover:htw-rotate-90"
                >
                  <XCircleIcon height={16} width={16} />
                </IconButton>
              </div>
            )}
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}
