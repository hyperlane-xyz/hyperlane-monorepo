/// <reference types="jest" />
import axios from 'axios';
import type { AxiosResponse } from 'axios';
import { fetchStatus, parseStatus, StatusError, type Status } from './status.js';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('status module', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('parseStatus', () => {
    it('returns a Status object when all required fields are present', () => {
      const raw = { id: '123', status: 'online', message: 'All good' };
      const result = parseStatus(raw);
      expect(result).toEqual({
        id: '123',
        status: 'online',
        message: 'All good',
      });
    });

    it('applies default values for missing optional fields', () => {
      const raw = { id: '123', status: 'offline' };
      const result = parseStatus(raw);
      expect(result).toEqual({
        id: '123',
        status: 'offline',
        message: '',
      });
    });

    it('throws StatusError when input is null or undefined', () => {
      expect(() => parseStatus(null)).toThrow(StatusError);
      expect(() => parseStatus(undefined)).toThrow(StatusError);
    });
  });

  describe('fetchStatus', () => {
    const dummyStatus: Status = { id: 'abc', status: 'ok', message: 'test' };
    const axiosResponse: AxiosResponse = {
      data: dummyStatus,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    };

    it('resolves with parsed Status on successful HTTP 200 response', async () => {
      mockedAxios.get.mockResolvedValue(axiosResponse);
      await expect(fetchStatus('abc')).resolves.toEqual(dummyStatus);
      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining('/abc'));
    });

    it('throws StatusError when HTTP status is not 200', async () => {
      const badResponse = { ...axiosResponse, status: 404, statusText: 'Not Found' };
      mockedAxios.get.mockResolvedValue(badResponse);
      await expect(fetchStatus('abc')).rejects.toThrow(StatusError);
      await expect(fetchStatus('abc')).rejects.toThrow('404');
    });

    it('throws underlying error for network failures', async () => {
      const networkError = new Error('Network Error');
      mockedAxios.get.mockRejectedValue(networkError);
      await expect(fetchStatus('abc')).rejects.toThrow(networkError);
    });

    it('throws StatusError on empty id input', async () => {
      await expect(fetchStatus('')).rejects.toThrow(StatusError);
    });
  });
});