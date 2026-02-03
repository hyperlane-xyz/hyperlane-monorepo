import React, { SVGProps, memo } from 'react';

function _TronLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 200 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <circle cx="100" cy="100" r="100" fill="#FF0013" />
      <path
        d="M156.562 72.843L99.484 41.016L40.516 74.484L66.14 89.484L100 69.656L133.86 89.484L100 159.75L156.562 72.843Z"
        fill="white"
      />
      <path
        d="M100 69.656L66.14 89.484L100 109.312L133.86 89.484L100 69.656Z"
        fill="#FF0013"
        fillOpacity="0.3"
      />
      <path
        d="M100 109.312L66.14 89.484L40.516 74.484L100 159.75L100 109.312Z"
        fill="white"
        fillOpacity="0.8"
      />
    </svg>
  );
}

export const TronLogo = memo(_TronLogo);
