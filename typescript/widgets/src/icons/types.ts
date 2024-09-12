import { InputHTMLAttributes, SVGProps } from 'react';

export type DefaultIconProps = SVGProps<SVGSVGElement> & {
  color?: string;
};

export type InputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'onChange'
> & {
  onChange: (v: string) => void;
  className?: string;
};
