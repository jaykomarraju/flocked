// Cloudflare Turnstile (spec "Anti-abuse"): a token for sign-ins that may create an account. The
// widget renders invisibly and only asks for interaction when Cloudflare wants it.
import { turnstileSiteKey } from './config';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      appearance?: 'always' | 'execute' | 'interaction-only';
      callback: (token: string) => void;
      'error-callback': () => void;
      'expired-callback'?: () => void;
    },
  ) => string;
  remove: (id: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load'));
    script.onerror = () => {
      loading = null;
      reject(new Error('Turnstile did not load'));
    };
    document.head.append(script);
  });
  return loading;
}

/** A fresh Turnstile token, or undefined when this build has no site key (dev servers). */
export async function turnstileToken(): Promise<string | undefined> {
  const sitekey = turnstileSiteKey();
  if (!sitekey) return undefined;
  const api = await loadTurnstile();
  const host = document.createElement('div');
  host.dataset.turnstile = '';
  document.body.append(host);
  try {
    return await new Promise<string>((resolve, reject) => {
      api.render(host, {
        sitekey,
        appearance: 'interaction-only',
        callback: resolve,
        'error-callback': () => reject(new Error('The human check failed')),
      });
    });
  } finally {
    host.remove();
  }
}
