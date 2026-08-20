import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG, type ApiConfig } from './api/config.ts';

export interface Settings extends ApiConfig {
  /** Start the API as soon as the app launches. */
  autoStart: boolean;
}

export const DEFAULT_SETTINGS: Settings = { ...DEFAULT_CONFIG, autoStart: true };

/**
 * A tiny atomic JSON store. Deliberately dependency-free: the alternatives are
 * ESM-only, and electron-vite externalises main-process dependencies, which
 * makes an ESM-only package unloadable from the CommonJS main bundle.
 */
export class SettingsStore {
  readonly #path: string;
  #value: Settings;

  constructor(directory: string) {
    this.#path = join(directory, 'settings.json');
    this.#value = { ...DEFAULT_SETTINGS, ...this.#read() };
  }

  #read(): Partial<Settings> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#path, 'utf8'));
      return parsed && typeof parsed === 'object' ? (parsed as Partial<Settings>) : {};
    } catch {
      return {};
    }
  }

  get(): Settings {
    return { ...this.#value };
  }

  update(patch: Partial<Settings>): Settings {
    this.#value = { ...this.#value, ...patch };
    mkdirSync(dirname(this.#path), { recursive: true });
    // Write-then-rename so a crash mid-write cannot truncate the settings file.
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.#value, null, 2), 'utf8');
    renameSync(temporary, this.#path);
    return this.get();
  }
}
