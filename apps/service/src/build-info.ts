declare const __AGENT_TOWN_BUILD__: { id: string; builtAt: string; webEntry: string | null } | undefined;
export const buildInfo = typeof __AGENT_TOWN_BUILD__ === 'undefined'
  ? { id: 'development-source', builtAt: null, webEntry: null }
  : __AGENT_TOWN_BUILD__;
