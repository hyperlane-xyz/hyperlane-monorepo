import React, { Component, PropsWithChildren, ReactNode } from 'react';

import { errorToString } from '@hyperlane-xyz/utils';

import { ErrorIcon } from '../icons/Error.js';
import { widgetLogger } from '../logger.js';

type Props = PropsWithChildren<{
  supportLink?: ReactNode;
}>;

interface State {
  error: any;
  errorInfo: any;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, errorInfo: null };
  }

  componentDidCatch(error: any, errorInfo: any) {
    this.setState({
      error,
      errorInfo,
    });
    widgetLogger.error('Error caught by error boundary', error, errorInfo);
  }

  render() {
    const errorInfo = this.state.error || this.state.errorInfo;
    if (errorInfo) {
      const details = errorToString(errorInfo, 1000);
      return (
        <div className="htw-flex htw-h-screen htw-w-screen htw-items-center htw-justify-center htw-bg-gray-50">
          <div className="htw-flex htw-flex-col htw-items-center htw-space-y-5">
            <ErrorIcon width={80} height={80} />
            <h1 className="htw-text-lg">Fatal Error Occurred</h1>
            <div className="htw-max-w-2xl htw-text-sm">{details}</div>
            {this.props.supportLink}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
