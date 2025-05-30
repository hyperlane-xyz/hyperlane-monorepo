import { Router } from 'express';

export abstract class BaseService {
  public readonly router: Router;
  protected constructor(..._args: any[]) {
    this.router = Router();
  }

  static async initialize(): Promise<BaseService> {
    throw new Error('Service must implement static initialize method');
  }
}
