// It is necessary to import something from express, even if it's not used
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import express from 'express';
import { Logger } from 'pino';

declare global {
  namespace Express {
    export interface Request {
      log: Logger;
    }
  }
}
