import React from 'react';

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <div
      className={`htw-animate-pulse-slow htw-bg-gray-200 htw-rounded ${className}`}
    />
  );
}
