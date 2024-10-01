import {
  PopoverButton,
  PopoverPanel,
  Popover as _Popover,
} from '@headlessui/react';
import clsx from 'clsx';
import React, { ComponentProps, PropsWithChildren, ReactNode } from 'react';

export type PopoverProps = PropsWithChildren<{
  button: ReactNode;
  buttonClassname?: string;
  buttonProps?: ComponentProps<typeof PopoverButton>;
  panelClassname?: string;
  panelProps?: ComponentProps<typeof PopoverPanel>;
}>;

export function Popover({
  button,
  buttonClassname,
  buttonProps,
  panelClassname,
  panelProps,
  children,
}: PopoverProps) {
  return (
    <_Popover>
      <PopoverButton
        className={clsx('htw-focus:outline-none', buttonClassname)}
        {...buttonProps}
      >
        {button}
      </PopoverButton>
      <PopoverPanel
        transition
        anchor="bottom"
        className={clsx(
          'htw-rounded htw-bg-white/90 htw-border htw-border-gray-100 htw-shadow-md htw-drop-shadow-md htw-backdrop-blur htw-transition htw-duration-200 htw-ease-in-out htw-focus:outline-none [--anchor-gap:var(--spacing-5)] data-[closed]:htw--translate-y-1 data-[closed]:htw-opacity-0',
          panelClassname,
        )}
        {...panelProps}
      >
        {children}
      </PopoverPanel>
    </_Popover>
  );
}
