import { describe, expect, it, vi } from 'vitest';
import { startBrowserFarcaster, type FarcasterBrowserDeps } from './farcaster-browser';

function deps(statuses: Awaited<ReturnType<FarcasterBrowserDeps['relay']['status']>>[]) {
  const status = vi.fn<FarcasterBrowserDeps['relay']['status']>();
  for (const s of statuses) status.mockResolvedValueOnce(s);
  status.mockResolvedValue({ state: 'pending' });
  const d: FarcasterBrowserDeps = {
    quickAuth: {
      generateNonce: vi.fn(() => Promise.resolve('qa-nonce')),
      verifySiwf: vi.fn(() => Promise.resolve({ token: 'quick-auth-jwt' })),
    },
    relay: {
      createChannel: vi.fn(() =>
        Promise.resolve({
          channelToken: 'ch',
          url: 'https://farcaster.xyz/~/siwf?channelToken=ch',
        }),
      ),
      status,
    },
  };
  return d;
}

describe('browser Farcaster sign-in', () => {
  it('opens a channel for this origin with the Quick Auth nonce, then trades the signed message for a token', async () => {
    const d = deps([
      { state: 'pending' },
      { state: 'completed', message: 'siwf message', signature: '0xsig' },
    ]);
    const req = await startBrowserFarcaster({
      origin: new URL('https://flocked.xyz'),
      deps: d,
      pollMs: 1,
    });
    expect(req.url).toBe('https://farcaster.xyz/~/siwf?channelToken=ch');
    expect(d.relay.createChannel).toHaveBeenCalledWith({
      siweUri: 'https://flocked.xyz',
      domain: 'flocked.xyz',
      nonce: 'qa-nonce',
    });
    await expect(req.token).resolves.toBe('quick-auth-jwt');
    expect(d.quickAuth.verifySiwf).toHaveBeenCalledWith({
      domain: 'flocked.xyz',
      message: 'siwf message',
      signature: '0xsig',
    });
  });

  it('stops when cancelled and when it times out', async () => {
    const cancelled = await startBrowserFarcaster({
      origin: new URL('https://flocked.xyz'),
      deps: deps([]),
      pollMs: 1,
    });
    cancelled.cancel();
    await expect(cancelled.token).rejects.toThrow(/cancelled/);
    const late = await startBrowserFarcaster({
      origin: new URL('https://flocked.xyz'),
      deps: deps([]),
      pollMs: 1,
      timeoutMs: 5,
    });
    await expect(late.token).rejects.toThrow(/timed out/);
  });
});
