import { AppConstants } from '../constants/AppConstants.js';

export class ApiError extends Error {
  public status: number;
  public stack?: string;

  constructor(message: string, status?: number, stack?: string) {
    super(message);
    this.status = status ?? AppConstants.HTTP_STATUS_INTERNAL_SERVER_ERROR;
    this.stack = stack;
  }
}

export class NotFoundError extends ApiError {
  constructor(resource: string) {
    super(`${resource} not found`, AppConstants.HTTP_STATUS_NOT_FOUND);
  }
}
