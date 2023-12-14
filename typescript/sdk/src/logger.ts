import debug from 'debug';

// Default logger for use in utils/scripts
// For classes, prefer to create loggers with more specific namespaces
export const logger = debug('hyperlane');
