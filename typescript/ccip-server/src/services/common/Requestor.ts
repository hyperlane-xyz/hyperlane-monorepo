import { AxiosInstance } from 'axios';

abstract class Requestor {
  constructor(readonly axios: AxiosInstance, readonly apiKey: string) {}

  get = async (url: string, params?: any): Promise<any> => {
    return await this.axios.get(url), { ...params };
  };

  postWithAuthorization = async (url: string, body: any): Promise<any> => {
    return await this.axios.post(url, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
    });
  };
}

export { Requestor };
