import { describe, expect, it, vi } from 'vitest';
import { SpaListener } from '../src/playwright/spa-listener';

describe('SpaListener', () => {
  it('starts with all observations null + isReady=false', () => {
    const l = new SpaListener();
    const obs = l.observation();
    expect(obs.inboxHash).toBeNull();
    expect(obs.threadHash).toBeNull();
    expect(obs.clientVersion).toBeNull();
    expect(obs.lastObservedAtMs).toBeNull();
    expect(l.isReady()).toBe(false);
  });

  it('install registers a request listener once', () => {
    const l = new SpaListener();
    const fakePage = { on: vi.fn() } as unknown as Parameters<SpaListener['install']>[0];
    l.install(fakePage);
    l.install(fakePage); // second call is no-op
    expect((fakePage as unknown as { on: ReturnType<typeof vi.fn> }).on).toHaveBeenCalledTimes(1);
  });

  it('captures inbox hash from ViaductInboxData URL path', () => {
    const l = new SpaListener();
    let handler: (req: unknown) => void = () => undefined;
    const fakePage = {
      on: (event: string, h: (req: unknown) => void) => {
        if (event === 'request') handler = h;
      },
    } as unknown as Parameters<SpaListener['install']>[0];
    l.install(fakePage);

    const fakeReq = {
      url: () =>
        'https://www.airbnb.com/api/v3/ViaductInboxData/' +
        'ebeb240346015c12be36d76fd7003cbef5658e1c6d2e60b3554280b3c081aeea?...',
      headers: () => ({ 'x-client-version': 'sha-abc123' }),
    };
    handler(fakeReq);

    const obs = l.observation();
    expect(obs.inboxHash).toBe('ebeb240346015c12be36d76fd7003cbef5658e1c6d2e60b3554280b3c081aeea');
    expect(obs.clientVersion).toBe('sha-abc123');
    expect(obs.lastObservedAtMs).not.toBeNull();
    expect(l.isReady()).toBe(false); // no thread hash yet
  });

  it('captures thread hash from ViaductGetThreadAndDataQuery URL path', () => {
    const l = new SpaListener();
    let handler: (req: unknown) => void = () => undefined;
    const fakePage = {
      on: (event: string, h: (req: unknown) => void) => {
        if (event === 'request') handler = h;
      },
    } as unknown as Parameters<SpaListener['install']>[0];
    l.install(fakePage);

    handler({
      url: () =>
        'https://www.airbnb.com/api/v3/ViaductGetThreadAndDataQuery/' +
        '9384287931cf3da66dd1fae72eb9d28e588de4066e05d34a657e30a9e9d2e9ef?...',
      headers: () => ({ 'x-client-version': 'sha-def456' }),
    });

    const obs = l.observation();
    expect(obs.threadHash).toBe('9384287931cf3da66dd1fae72eb9d28e588de4066e05d34a657e30a9e9d2e9ef');
  });

  it('isReady() flips true only when ALL three observations captured', () => {
    const l = new SpaListener();
    expect(l.isReady()).toBe(false);
    l._injectForTesting({ inboxHash: 'a' });
    expect(l.isReady()).toBe(false);
    l._injectForTesting({ threadHash: 'b' });
    expect(l.isReady()).toBe(false);
    l._injectForTesting({ clientVersion: 'c' });
    expect(l.isReady()).toBe(true);
  });

  it('ignores non-Viaduct URLs', () => {
    const l = new SpaListener();
    let handler: (req: unknown) => void = () => undefined;
    const fakePage = {
      on: (event: string, h: (req: unknown) => void) => {
        if (event === 'request') handler = h;
      },
    } as unknown as Parameters<SpaListener['install']>[0];
    l.install(fakePage);

    handler({
      url: () => 'https://www.airbnb.com/api/v3/SomeOtherQuery/abc',
      headers: () => ({ 'x-client-version': 'sha-ignore' }),
    });
    handler({
      url: () => 'https://www.airbnb.com/static/some.js',
      headers: () => ({}),
    });

    expect(l.observation().inboxHash).toBeNull();
    expect(l.observation().threadHash).toBeNull();
    expect(l.observation().clientVersion).toBeNull();
  });

  it('listener errors do not propagate (caught internally)', () => {
    const l = new SpaListener();
    let handler: (req: unknown) => void = () => undefined;
    const fakePage = {
      on: (event: string, h: (req: unknown) => void) => {
        if (event === 'request') handler = h;
      },
    } as unknown as Parameters<SpaListener['install']>[0];
    l.install(fakePage);

    expect(() => {
      handler({
        url: () => {
          throw new Error('boom');
        },
        headers: () => ({}),
      });
    }).not.toThrow();
  });
});
