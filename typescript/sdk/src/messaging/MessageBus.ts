import { EventEmitter } from 'events';

import { DispatchedMessage } from '../core/types.js';

export type MessageHandler = (message: DispatchedMessage) => Promise<void>;

export class MessageBus {
  private emitter = new EventEmitter();

  subscribe(handler: MessageHandler): () => void {
    this.emitter.on('message', handler);
    return () => this.emitter.off('message', handler);
  }

  publish(message: DispatchedMessage): void {
    this.emitter.emit('message', message);
  }
}
