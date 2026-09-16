export type ApplicationMode = 'demo' | 'development' | 'production';
export interface RuntimeConfig { mode: ApplicationMode; modeSource: 'environment' | 'configuration' | 'default'; githubClientId: string }
export interface ConfigOptions { projectDirectory?: string; env?: NodeJS.ProcessEnv }
export function normalizeApplicationMode(value: unknown): ApplicationMode;
export function readRuntimeConfig(options?: ConfigOptions): RuntimeConfig;
export function runtimeDataPaths(mode: ApplicationMode, options?: ConfigOptions & { platform?: NodeJS.Platform }): { directory: string; privateDirectory: string; database: string };
