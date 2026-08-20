import type { ClientBridge } from '../main/ipc.ts';

declare global {
  interface Window {
    chateria: ClientBridge;
  }
}

export {};
