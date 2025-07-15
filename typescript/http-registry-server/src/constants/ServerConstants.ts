export const ServerConstants = Object.freeze({
  DEFAULT_PORT: 3001,
  DEFAULT_REFRESH_INTERVAL: 1000 * 60 * 5, // 5 minutes
  DEFAULT_HOST: '127.0.0.1',
} as const);

export default ServerConstants;
