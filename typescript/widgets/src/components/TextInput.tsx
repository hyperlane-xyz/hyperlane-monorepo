import React, { ChangeEvent, InputHTMLAttributes } from 'react';

export type InputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'onChange'
> & {
  onChange?: (v: string) => void;
  className?: string;
};

export function TextInput({ onChange, className, ...props }: InputProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (onChange) onChange(e?.target?.value || '');
  };

  return (
    <input
      type="text"
      autoComplete="off"
      onChange={handleChange}
      className={`htw-bg-gray-100 focus:htw-bg-gray-200 disabled:htw-bg-gray-500 htw-outline-none htw-transition-all htw-duration-300 ${className}`}
      {...props}
    />
  );
}
