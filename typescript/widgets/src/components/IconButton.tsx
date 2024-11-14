import clsx from 'clsx';
import React, { ButtonHTMLAttributes, PropsWithChildren } from 'react';

type Props = PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>> & {
  width?: number;
  height?: number;
};

export function IconButton(props: Props) {
  const { className, children, type, ...rest } = props;

  const base =
    'htw-flex htw-items-center htw-justify-center htw-transition-all';
  const onHover = 'hover:htw-opacity-70';
  const onDisabled = 'disabled:htw-opacity-30 disabled:htw-cursor-default';
  const onActive = 'active:htw-opacity-60';
  const allClasses = clsx(base, onHover, onDisabled, onActive, className);

  return (
    <button type={type || 'button'} className={allClasses} {...rest}>
      {children}
    </button>
  );
}
