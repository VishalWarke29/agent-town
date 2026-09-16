import { readRuntimeConfig, runtimeDataPaths, type ApplicationMode, type ConfigOptions } from '../../../scripts/runtime-config.mjs';
import { projectRoot } from './store.js';

export function readLocalConfig(options: ConfigOptions = {}) {
  return readRuntimeConfig({ projectDirectory: projectRoot, ...options });
}

export function applicationDataPaths(mode: ApplicationMode, options: ConfigOptions = {}) {
  return runtimeDataPaths(mode, { projectDirectory: projectRoot, ...options });
}
