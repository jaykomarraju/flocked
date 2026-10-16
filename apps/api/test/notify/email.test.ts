// The email channel (src/notify/channels/email.ts): the body, the combined outcome's next-question
// paragraph and link, the footer, escaping, and retries on a failed send.
import { env } from 'cloudflare:test';
import { EMAIL_CHROME, OUTCOME_NEXT_LIVE } from '@flocked/shared';
import { describe, expect, it } from 'vitest';
import { buildEmail, emailChannel, type OutgoingEmail } from '../../src/notify/channels/email.js';
import { channelsFor } from '../../src/notify/channels/index.js';
import type { Delivery, Recipient } from '../../src/notify/types.js';

const recipient: Recipient = {
  userId: 'u',
  excluded: false,
  email: 'player@example.com',
  pushSubscriptions: [],
  farcasterTokens: [],
  prefs: new Map(),
};

const outcome: Delivery<'email'> = {
  event: 'outcome',
  dedupeKey: 'outcome:2026-10-08:u',
  recipient,
  copy: {
    subject: 'Unflocked +87 pts',
    preheader: 'You and 25% of people out-thought everyone.',
    heading: 'UNFLOCKED +87 pts',
    body: 'You and 25% of people out-thought everyone.',
    cta: 'See the reveal',
  },
  targetUrl: 'https://flocked.xyz/r/01K70000000000000000000020',
  nextLive: true,
};

const security: Delivery<'email'> = {
  event: 'security_notice',
  dedupeKey: 'security_notice:n1',
  recipient,
  copy: {
    subject: 'Sign-in method removed',
    preheader: 'A sign-in method was removed from your account.',
    heading: 'Sign-in method removed',
    body: "If it wasn't you, <review> your sign-in methods & settings.",
    cta: 'Open Settings',
  },
  targetUrl: 'https://flocked.xyz/settings',
};

describe('buildEmail', () => {
  it('the combined outcome: body, the next question paragraph and link, the CTA, the optional footer', () => {
    const e = buildEmail(outcome, 'hello@flocked.xyz');
    expect(e.from).toEqual({ name: 'Flocked', email: 'hello@flocked.xyz' });
    expect(e.to).toBe('player@example.com');
    expect(e.subject).toBe('Unflocked +87 pts');
    expect(e.text).toBe(
      [
        'UNFLOCKED +87 pts',
        '',
        'You and 25% of people out-thought everyone.',
        '',
        OUTCOME_NEXT_LIVE,
        'Play the next question: https://flocked.xyz/',
        '',
        'See the reveal: https://flocked.xyz/r/01K70000000000000000000020',
        '',
        '--',
        EMAIL_CHROME.footerOptional,
        'Manage notifications: https://flocked.xyz/settings',
        '',
      ].join('\n'),
    );
    expect(e.html).toContain('You and 25% of people out-thought everyone.</span>');
    expect(e.html).toContain('<a href="https://flocked.xyz/">Play the next question</a>');
    expect(e.html).toContain('Manage notifications');
    expect(e.html).not.toContain('<img');
  });

  it('a security notice says it is always on, links no settings footer, and escapes HTML', () => {
    const e = buildEmail(security, 'hello@flocked.xyz');
    expect(e.text).toContain(EMAIL_CHROME.footerRequired);
    expect(e.text).not.toContain(EMAIL_CHROME.manageLink);
    expect(e.text).not.toContain(OUTCOME_NEXT_LIVE);
    expect(e.html).toContain('&lt;review&gt; your sign-in methods &amp; settings.');
    expect(e.html).not.toContain('<review>');
  });
});

describe('emailChannel', () => {
  it('sends each delivery, and retries one whose send threw', async () => {
    const sent: OutgoingEmail[] = [];
    let fail = true;
    const ch = emailChannel({
      from: 'hello@flocked.xyz',
      send: (e) => {
        if (fail && e.subject.startsWith('Sign-in')) {
          fail = false;
          return Promise.reject(new Error('rate limited'));
        }
        sent.push(e);
        return Promise.resolve();
      },
    });
    expect(ch.available(recipient)).toBe(true);
    expect(ch.available({ ...recipient, email: null })).toBe(false);
    expect(await ch.send([outcome, security])).toEqual({ retry: ['security_notice:n1'] });
    expect(sent.map((e) => e.subject)).toEqual(['Unflocked +87 pts']);
    expect(await ch.send([security])).toEqual({ retry: [] });
  });

  it('is configured only with a sender address', () => {
    expect(
      channelsFor({ ...env, EMAIL_FROM: '', NOTIFY_EMAIL_FROM: '' }, () => 0).email,
    ).toBeUndefined();
    expect(
      channelsFor({ ...env, NOTIFY_EMAIL_FROM: 'hello@flocked.xyz' }, () => 0).email,
    ).toBeDefined();
    expect(channelsFor({ ...env }, () => 0).farcaster).toBeDefined();
  });
});
