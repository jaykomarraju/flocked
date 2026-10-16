// Email (spec "Notifications": `outcome` if verified, `payout_claimable`, `refunded`, `security_notice`),
// through the Cloudflare Email Service `send_email` binding. The copy is the event's EmailCopy: subject,
// a hidden preheader, the heading, the body, then (for the combined `outcome`) "The next question is
// live." with its link, the one CTA button, and the EMAIL_CHROME footer: security notices say they
// are always on; everything else links to the notification settings. No card image for now (W6-Z).
// A send that throws is retried with its message; the queue's DLQ takes one that keeps failing.
import { EMAIL_CHROME, EMAIL_NEXT_LINK, OUTCOME_NEXT_LIVE } from '@flocked/shared';
import { log } from '../../lib/log.js';
import type { Channel, Delivery, SendOutcome } from '../types.js';

/** One email as the binding takes it (`SendEmail.send(builder)`). */
export interface OutgoingEmail {
  from: { name: string; email: string };
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailDeps {
  send: (email: OutgoingEmail) => Promise<unknown>;
  /** The sender address (a verified Email Sending address on the domain, OA-07). */
  from: string;
}

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

/** The email for a delivery: subject, plain text and HTML. */
export function buildEmail(d: Delivery<'email'>, from: string): OutgoingEmail {
  const { subject, preheader, heading, body, cta } = d.copy;
  const origin = new URL(d.targetUrl).origin;
  const settings = new URL('/settings', origin).toString();
  const next = d.nextLive ? new URL('/', origin).toString() : null;
  const footer =
    d.event === 'security_notice' ? EMAIL_CHROME.footerRequired : EMAIL_CHROME.footerOptional;

  const text = [
    heading,
    '',
    body,
    ...(next ? ['', OUTCOME_NEXT_LIVE, `${EMAIL_NEXT_LINK}: ${next}`] : []),
    '',
    `${cta}: ${d.targetUrl}`,
    '',
    '--',
    footer,
    ...(d.event === 'security_notice' ? [] : [`${EMAIL_CHROME.manageLink}: ${settings}`]),
    '',
  ].join('\n');

  const p = (inner: string, style = '') =>
    `<p style="margin:0 0 16px;font-size:16px;line-height:24px;${style}">${inner}</p>`;
  const link = (href: string, label: string) => `<a href="${esc(href)}">${esc(label)}</a>`;
  const html = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    '<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;color:#111">',
    `<span style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</span>`,
    '<div style="max-width:520px;margin:0 auto">',
    `<h1 style="margin:0 0 16px;font-size:28px;line-height:32px">${esc(heading)}</h1>`,
    p(esc(body)),
    ...(next ? [p(esc(OUTCOME_NEXT_LIVE)), p(link(next, EMAIL_NEXT_LINK))] : []),
    p(
      `<a href="${esc(d.targetUrl)}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#111;color:#fff;text-decoration:none">${esc(cta)}</a>`,
    ),
    `<hr style="border:0;border-top:1px solid #ddd;margin:24px 0">`,
    p(esc(footer), 'font-size:13px;line-height:20px;color:#666'),
    ...(d.event === 'security_notice'
      ? []
      : [p(link(settings, EMAIL_CHROME.manageLink), 'font-size:13px;line-height:20px')]),
    '</div></body></html>',
  ].join('');

  return {
    from: { name: EMAIL_CHROME.fromName, email: from },
    to: d.recipient.email ?? '',
    subject,
    text,
    html,
  };
}

/** The email channel. */
export function emailChannel(deps: EmailDeps): Channel<'email'> {
  return {
    name: 'email',
    available: (r) => r.email !== null,
    async send(batch: readonly Delivery<'email'>[]): Promise<SendOutcome> {
      const retry: string[] = [];
      for (const d of batch) {
        if (!d.recipient.email) continue;
        try {
          await deps.send(buildEmail(d, deps.from));
        } catch (err) {
          log.warn('email_send_failed', {
            event: d.event,
            dedupeKey: d.dedupeKey,
            error: err instanceof Error ? err.message : String(err),
          });
          retry.push(d.dedupeKey);
        }
      }
      return { retry };
    },
  };
}
