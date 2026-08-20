import type { ServerBridge } from '../main/ipc.ts';

declare global {
  interface Window {
    chateria: ServerBridge;
  }
}

export {};
