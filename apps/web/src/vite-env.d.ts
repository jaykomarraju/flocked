/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Cloudflare Turnstile site key (public). Required for production builds. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  /** The chain the app signs in on (SIWE `chainId`): 8453 Base, 84532 Base Sepolia, 31337 local. */
  readonly VITE_CHAIN_ID?: string;
}
