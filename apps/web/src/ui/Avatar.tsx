// The avatar (Paper Components › Lists › Avatar): a circle with an ink ring (2px at 40 and up, 1.5px
// below). The Farcaster or Base profile picture fills it; without one (or when it fails to load), the
// handle's first letter in Fredoka on surface. 64 on Profile, 40 on boards, 32 in the header, 24 inline.
import { useState } from 'react';
import s from './Avatar.module.css';

export type AvatarSize = 64 | 40 | 32 | 24;

export interface AvatarProps {
  /** The handle, with or without the leading `@`; its first letter is the fallback. */
  handle: string;
  size: AvatarSize;
  /** The profile picture URL. */
  src?: string | null;
  /**
   * The accessible name (the picture's alt text). Omit it when the handle is shown next to the
   * avatar, as on boards and Profile: the avatar is then decorative.
   */
  alt?: string;
  className?: string;
}

/** The fallback letter: the handle's first character (after any `@`), upper case. */
export function avatarInitial(handle: string): string {
  const first = Array.from(handle.replace(/^@/, '').trim())[0];
  return first ? first.toLocaleUpperCase() : '?';
}

export function Avatar({ handle, size, src, alt, className }: AvatarProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = Boolean(src) && failed !== src;
  const classes = [s.avatar, s[`size${size}`], className].filter(Boolean).join(' ');
  if (showImage) {
    return (
      <span className={classes}>
        <img
          className={s.image}
          src={src ?? undefined}
          alt={alt ?? ''}
          width={size}
          height={size}
          onError={() => setFailed(src ?? null)}
        />
      </span>
    );
  }
  const a11y =
    alt === undefined ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': alt };
  return (
    <span className={classes} {...a11y}>
      <span className={s.initial}>{avatarInitial(handle)}</span>
    </span>
  );
}
