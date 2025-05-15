import React, { SVGProps, memo } from 'react';

function _BinanceLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 126.61 126.61"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g fill="#f3ba2f">
        <path d="m38.73 53.2 24.59-24.58 24.6 24.6 14.3-14.31-38.9-38.91-38.9 38.9z" />
        <path d="m0 63.31 14.3-14.31 14.31 14.31-14.31 14.3z" />
        <path d="m38.73 73.41 24.59 24.59 24.6-24.6 14.31 14.29-38.9 38.91-38.91-38.88z" />
        <path d="m98 63.31 14.3-14.31 14.31 14.3-14.31 14.32z" />
        <path d="m77.83 63.3-14.51-14.52-10.73 10.73-1.24 1.23-2.54 2.54 14.51 14.5 14.51-14.47z" />
      </g>
    </svg>
  );
}

export const BinanceLogo = memo(_BinanceLogo);
