import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubDeviceProvider } from '../../apps/service/src/identity/github';

const installation = (id = 1) => ({ id, permissions: { metadata: 'read', contents: 'read' }, suspended_at: null });
const repository = (id = 1) => ({ id, name: `project-${id}`, full_name: `fixture/project-${id}`, private: true, default_branch: 'main', archived: false, html_url: `https://github.com/fixture/project-${id}` });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { vi.useRealTimers(); });

describe('bounded GitHub installation listing', () => {
  it('distinguishes no installation from installed with no repositories', async () => {
    const none = new GitHubDeviceProvider(vi.fn(async () => json({ total_count: 0, installations: [] })) as typeof fetch);
    expect(await none.listRepositories('fixture-token')).toMatchObject({ truncated: false, repositories: [], diagnostics: { installationCount: 0, installationTotal: 0, repositoryTotal: 0, reasons: ['no-installations'] } });
    const request = vi.fn(async (url: string | URL | Request) => String(url).includes('/user/installations?') ? json({ total_count: 1, installations: [installation()] }) : json({ total_count: 0, repositories: [] }));
    expect(await new GitHubDeviceProvider(request as typeof fetch).listRepositories('fixture-token')).toMatchObject({ truncated: false, repositories: [], diagnostics: { installationCount: 1, repositoryTotal: 0, reasons: ['no-repositories'] } });
    expect(request.mock.calls.map(call => String(call[0]))).toEqual(['https://api.github.com/user/installations?per_page=100&page=1', 'https://api.github.com/user/installations/1/repositories?per_page=100&page=1']);
  });

  it('skips suspended installations and retains explicit partial coverage without inventing totals', async () => {
    const request = vi.fn(async () => json({ total_count: 2, installations: [{ ...installation(), suspended_at: '2026-09-14T12:00:00Z' }] }));
    expect(await new GitHubDeviceProvider(request as typeof fetch).listRepositories('fixture-token')).toMatchObject({ truncated: true, diagnostics: { installationCount: 1, installationTotal: 2, suspendedInstallations: 1, repositoryTotal: null, reasons: ['installation-limit', 'suspended-installation'] } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects write access and unsafe repository links without accepting partial metadata', async () => {
    const broad = vi.fn(async () => json({ total_count: 1, installations: [{ ...installation(), permissions: { contents: 'write' } }] }));
    await expect(new GitHubDeviceProvider(broad as typeof fetch).listRepositories('fixture-token')).rejects.toMatchObject({ code: 'github_permissions_too_broad', statusCode: 403 });
    expect(broad).toHaveBeenCalledTimes(1);
    const request = vi.fn(async (url: string | URL | Request) => String(url).includes('/user/installations?') ? json({ total_count: 1, installations: [installation()] }) : json({ total_count: 1, repositories: [{ ...repository(), html_url: 'https://github.com/fixture/project?secret=fixture-secret' }] }));
    await expect(new GitHubDeviceProvider(request as typeof fetch).listRepositories('fixture-token')).rejects.toMatchObject({ code: 'github_response_invalid' });
  });

  it.each([401, 403])('keeps %i failures actionable and free of raw provider bodies', async status => {
    const request = vi.fn(async () => json({ message: 'PRIVATE-PROVIDER-TEXT' }, status));
    try { await new GitHubDeviceProvider(request as typeof fetch).listRepositories('fixture-token'); throw new Error('Expected failure'); }
    catch (error) { expect(error).toMatchObject({ code: status === 401 ? 'github_unauthorized' : 'github_access_limited' }); expect(String(error)).not.toContain('PRIVATE'); }
  });

  it('uses one deadline across slow pages, retaining only fully received safe pages', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const request = vi.fn((url: string | URL | Request, options?: RequestInit) => {
      signals.push(options!.signal!);
      const install = String(url).includes('/user/installations?');
      const firstPage = String(url).endsWith('page=1');
      return new Promise<Response>(resolve => setTimeout(() => resolve(json(install ? { total_count: 1, installations: [installation()] } : { total_count: 2, repositories: [repository(firstPage ? 1 : 2)] })), install || firstPage ? 4000 : 10000));
    });
    const pending = new GitHubDeviceProvider(request as typeof fetch).listRepositories('fixture-token');
    await vi.advanceTimersByTimeAsync(12000);
    const result = await pending;
    expect(result.repositories.map(repo => repo.id)).toEqual(['1']);
    expect(result).toMatchObject({ truncated: true, diagnostics: { repositoryTotal: 2, reasons: ['deadline'] } });
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('labels an initial deadline and caller cancellation as listing failures, never sign-in cancellation', async () => {
    vi.useFakeTimers();
    const request = vi.fn(() => new Promise<Response>(() => undefined));
    const pending = new GitHubDeviceProvider(request as typeof fetch).listRepositories('fixture-token');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'github_listing_timeout', statusCode: 504 });
    await vi.advanceTimersByTimeAsync(12000); await assertion;
    const abort = new AbortController();
    const cancelled = new GitHubDeviceProvider(request as typeof fetch).listRepositories('fixture-token', abort.signal);
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'github_listing_cancelled', statusCode: 409 });
  });

  it('caps ten repository pages and reports the upstream total without returning unbounded records', async () => {
    const request = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/user/installations?')) return json({ total_count: 1, installations: [installation()] });
      const page = Number(new URL(String(url)).searchParams.get('page'));
      return json({ total_count: 1001, repositories: Array.from({ length: 100 }, (_, index) => repository((page - 1) * 100 + index + 1)) });
    });
    const result = await new GitHubDeviceProvider(request as typeof fetch).listRepositories('fixture-token');
    expect(result.repositories).toHaveLength(1000);
    expect(result).toMatchObject({ truncated: true, diagnostics: { repositoryTotal: 1001, reasons: ['page-limit'] } });
    expect(request).toHaveBeenCalledTimes(11);
  });
});
