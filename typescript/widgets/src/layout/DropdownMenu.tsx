import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import clsx from 'clsx';
import React, { ComponentProps, ReactNode } from 'react';

export type DropdownMenuProps = {
  button: ReactNode;
  buttonClassname?: string;
  buttonProps?: ComponentProps<typeof MenuButton>;
  menuClassname?: string;
  menuProps?: ComponentProps<typeof MenuItems>;
  menuItems: ReactNode[];
};

export function DropdownMenu({
  button,
  buttonClassname,
  buttonProps,
  menuClassname,
  menuProps,
  menuItems,
}: DropdownMenuProps) {
  return (
    <Menu>
      <MenuButton
        className={clsx('htw-focus:outline-none', buttonClassname)}
        {...buttonProps}
      >
        {button}
      </MenuButton>
      <MenuItems
        transition
        anchor="bottom"
        className={clsx(
          'htw-rounded htw-bg-white/90 htw-border htw-border-gray-100 htw-shadow-md htw-drop-shadow-md htw-backdrop-blur htw-transition htw-duration-200 htw-ease-in-out htw-focus:outline-none [--anchor-gap:var(--spacing-5)] data-[closed]:htw--translate-y-1 data-[closed]:htw-opacity-0 htw-cursor-pointer',
          menuClassname,
        )}
        {...menuProps}
      >
        {menuItems.map((mi, i) => (
          <MenuItem key={`menu-item-${i}`}>{mi}</MenuItem>
        ))}
      </MenuItems>
    </Menu>
  );
}
