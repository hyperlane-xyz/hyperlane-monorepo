import {
  parseRoute,
  buildEventMessage,
  filterInvalidRecords,
  groupByService,
} from './utils';

describe('utils', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Helper to generate consistent route objects
  function createRouteObj(
    overrides: Partial<{ service: string; version: string; path: string }> = {}
  ) {
    return {
      service: 'defaultService',
      version: 'v1',
      path: 'defaultPath',
      ...overrides,
    };
  }

  describe('parseRoute', () => {
    it('parses a valid route string into service, version, and path', () => {
      const input = '/svc/user/v1/foo';
      expect(parseRoute(input)).toEqual({
        service: 'user',
        version: 'v1',
        path: 'foo',
      });
    });

    it('returns null for empty or malformed routes', () => {
      expect(parseRoute('')).toBeNull();
      expect(parseRoute('/invalid')).toBeNull();
      expect(parseRoute('/svc//v1/')).toBeNull();
    });
  });

  describe('buildEventMessage', () => {
    it('creates a message with correct timestamp, service, route, status, and latency', () => {
      const routeObj = createRouteObj({ service: 'billing', path: 'pay' });
      const fakeDate = new Date('2023-12-31T00:00:00Z');
      jest.spyOn(global, 'Date').mockImplementation(() => fakeDate as any);

      const message = buildEventMessage(routeObj, 200, 123);
      expect(message).toEqual({
        timestamp: fakeDate.toISOString(),
        service: 'billing',
        route: 'pay',
        status: 200,
        latencyMs: 123,
      });
    });

    it('handles zero latency and status correctly', () => {
      const routeObj = createRouteObj();
      const fakeDate = new Date();
      jest.spyOn(global, 'Date').mockImplementation(() => fakeDate as any);

      const message = buildEventMessage(routeObj, 0, 0);
      expect(message.timestamp).toBe(fakeDate.toISOString());
      expect(message.status).toBe(0);
      expect(message.latencyMs).toBe(0);
    });
  });

  describe('filterInvalidRecords', () => {
    it('filters out records missing status or latencyMs', () => {
      const valid = { status: 200, latencyMs: 10 };
      const missingStatus = { latencyMs: 20 } as any;
      const missingLatency = { status: 500 } as any;
      expect(
        filterInvalidRecords([valid, missingStatus, missingLatency])
      ).toEqual([valid]);
    });

    it('returns an empty array if no records are valid', () => {
      const bad1 = { status: undefined as any };
      const bad2 = { latencyMs: undefined as any };
      expect(filterInvalidRecords([bad1, bad2])).toEqual([]);
    });
  });

  describe('groupByService', () => {
    it('groups route objects by their service property', () => {
      const routes = [
        createRouteObj({ service: 'auth', path: 'login' }),
        createRouteObj({ service: 'billing', path: 'pay' }),
        createRouteObj({ service: 'auth', path: 'logout' }),
      ];
      expect(groupByService(routes)).toEqual({
        auth: [
          { service: 'auth', version: 'v1', path: 'login' },
          { service: 'auth', version: 'v1', path: 'logout' },
        ],
        billing: [{ service: 'billing', version: 'v1', path: 'pay' }],
      });
    });

    it('returns an empty object when given an empty array', () => {
      expect(groupByService([])).toEqual({});
    });
  });
});