import React, { PropsWithChildren } from 'react';

export type CardProps = PropsWithChildren<{
  className?: string;
  inverseMargin?: boolean;
}>;

export function Card({ className, inverseMargin, children }: CardProps) {
  return (
    <div
      className={`${
        inverseMargin ? cardStyles.inverseMargin : cardStyles.padding
      } htw-relative htw-overflow-auto htw-rounded-2xl htw-bg-white ${className}`}
    >
      {children}
    </div>
  );
}

const cardStyles = {
  padding: 'htw-p-1.5 xs:htw-p-2 sm:htw-p-3 md:htw-p-4',
  // Should be inverse of cardPadding, used when something
  // should be flush with card edge
  inverseMargin: 'htw--m-1.5 xs:htw--m-2 sm:htw--m-3 md:htw--m-4',
};
