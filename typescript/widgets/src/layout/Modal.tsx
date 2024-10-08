import { Dialog, DialogBackdrop, DialogPanel } from '@headlessui/react';
import clsx from 'clsx';
import React, { ComponentProps, PropsWithChildren } from 'react';

import { IconButton } from '../components/IconButton.js';
import { XIcon } from '../icons/X.js';

export type ModalProps = PropsWithChildren<{
  isOpen: boolean;
  close: () => void;
  dialogClassname?: string;
  dialogProps?: ComponentProps<typeof Dialog>;
  panelClassname?: string;
  panelProps?: ComponentProps<typeof DialogPanel>;
  showCloseButton?: boolean;
}>;

export function Modal({
  isOpen,
  close,
  dialogClassname,
  dialogProps,
  panelClassname,
  panelProps,
  showCloseButton,
  children,
}: ModalProps) {
  return (
    <Dialog
      open={isOpen}
      as="div"
      className={clsx(
        'htw-relative htw-z-20 htw-focus:outline-none',
        dialogClassname,
      )}
      onClose={close}
      {...dialogProps}
    >
      <DialogBackdrop className="htw-fixed htw-inset-0 htw-bg-black/5 htw-transition-all htw-duration-200" />
      <div className="htw-fixed htw-inset-0 htw-z-20 htw-w-screen htw-overflow-y-auto">
        <div className="htw-flex htw-min-h-full htw-items-center htw-justify-center htw-p-4">
          <DialogPanel
            transition
            className={clsx(
              'htw-w-full htw-max-w-sm htw-max-h-[90vh] htw-rounded-lg htw-shadow htw-overflow-auto no-scrollbar htw-bg-white htw-duration-200 htw-ease-out data-[closed]:htw-transform-[scale(95%)] data-[closed]:htw-opacity-0 data-[closed]:htw--translate-y-1',
              panelClassname,
            )}
            {...panelProps}
          >
            {children}
            {showCloseButton && (
              <div className="htw-absolute htw-right-3 htw-top-3">
                <IconButton
                  onClick={close}
                  title="Close"
                  className="hover:htw-rotate-90"
                >
                  <XIcon height={10} width={10} />
                </IconButton>
              </div>
            )}
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}
