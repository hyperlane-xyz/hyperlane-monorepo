import { clsx } from 'clsx';
import React, { ButtonHTMLAttributes, PropsWithChildren } from 'react';

type Props = PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>;

export function LinkButton(props: Props) {
  const { className, children, ...rest } = props;

  const base =
    'htw-flex htw-items-center htw-justify-center htw-transition-all';
  const onHover = 'hover:htw-underline htw-underline-offset-2';
  const onDisabled = 'disabled:htw-opacity-30 disabled:htw-cursor-default';
  const onActive = 'active:htw-opacity-70';
  const allClasses = clsx(base, onHover, onDisabled, onActive, className);

  return (
    <button type="button" className={allClasses} {...rest}>
      {children}
    </button>
  );
}
