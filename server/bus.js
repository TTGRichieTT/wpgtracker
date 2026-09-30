import { EventEmitter } from 'node:events';

// Server-side events that the realtime layer forwards to connected clients.
export const bus = new EventEmitter();
