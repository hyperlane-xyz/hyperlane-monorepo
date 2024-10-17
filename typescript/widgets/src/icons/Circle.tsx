import React, { PropsWithChildren } from 'react';

import { seedToBgColor } from '../color.js';

export function Circle({
  size,
  title,
  bgColorSeed,
  className,
  children,
}: PropsWithChildren<{
  size: string | number;
  title?: string;
  bgColorSeed?: number;
  className?: string;
}>) {
  const bgColor =
    bgColorSeed === null || bgColorSeed == undefined
      ? ''
      : seedToBgColor(bgColorSeed);
  return (
    <div
      style={{ width: `${size}px`, height: `${size}px` }}
      className={`htw-flex htw-items-center htw-justify-center htw-rounded-full htw-transition-all overflow-hidden ${bgColor} ${className}`}
      title={title}
    >
      {children}
    </div>
  );
}
