import React, { type SVGProps, memo } from 'react';

function _RadixLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 200 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <circle cx="100" cy="100" r="100" fill="#052CC0" />
      <path
        d="M86.9684 148C85.1094 148 83.3419 147.111 82.2338 145.581L59.0921 113.497H44V101.816H62.0775C63.9549 101.816 65.7132 102.713 66.8121 104.234L85.723 130.446L114.579 64.4998C115.513 62.3743 117.61 61 119.927 61H156V72.6812H123.746L92.3166 144.5C91.4741 146.424 89.67 147.743 87.582 147.963C87.3897 147.991 87.1791 148 86.9684 148Z"
        fill="#00C389"
      />
    </svg>
  );
}

export const RadixLogo = memo(_RadixLogo);
