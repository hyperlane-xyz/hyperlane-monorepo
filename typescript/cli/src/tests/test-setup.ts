// SPDX-License-Identifier: BUSL-1.1
import { LogFormat, LogLevel, configureRootLogger } from '@hyperlane-xyz/utils';

// mute logging in tests
process.env.NODE_ENV === 'test' &&
  configureRootLogger(LogFormat.JSON, LogLevel.Off);
