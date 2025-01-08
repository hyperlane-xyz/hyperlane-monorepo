import { clsx } from 'clsx';
import React, { ButtonHTMLAttributes, PropsWithChildren } from 'react';

type Props = PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>;

export function Button(props: Props) {
  const { className, children, ...rest } = props;

  const base =
    'htw-flex htw-items-center htw-justify-center htw-rounded-sm htw-transition-all htw-outline-none focus:htw-outline-none';
  const onHover = 'hover:htw-opacity-80';
  const onDisabled = 'disabled:htw-opacity-30 disabled:htw-cursor-default';
  const onActive = 'active:htw-scale-95';
  const allClasses = clsx(base, onHover, onDisabled, onActive, className);

  return (
    <button type="button" className={allClasses} {...rest}>
      {children}
    </button>
  );
}
