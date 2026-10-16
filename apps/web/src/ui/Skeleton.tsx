// The skeleton (Paper Components › Feedback › Skeleton loading): line-filled blocks in the shape of
// Today (an eyebrow, two question lines, two option cards). No shimmer, since gradients are out. It
// appears only after 300ms, so fast loads never flash it. The blocks are hidden from assistive tech;
// the region is `aria-busy` and announces one "Loading" label.
import { useEffect, useState } from 'react';
import s from './Skeleton.module.css';

export interface SkeletonProps {
  /** The one label assistive tech hears. */
  label?: string;
  /** Wait this long (ms) before showing anything. */
  delay?: number;
  className?: string;
}

export const SKELETON_DELAY_MS = 300;

export function Skeleton({
  label = 'Loading',
  delay = SKELETON_DELAY_MS,
  className,
}: SkeletonProps) {
  const [shown, setShown] = useState(delay <= 0);

  useEffect(() => {
    if (delay <= 0) return;
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);

  if (!shown) return null;
  return (
    <div aria-busy="true" className={className ? `${s.skeleton} ${className}` : s.skeleton}>
      <span role="status" className="visually-hidden">
        {label}
      </span>
      <div aria-hidden="true" className={s.eyebrow} />
      <div aria-hidden="true" className={s.question} />
      <div aria-hidden="true" className={`${s.question} ${s.questionShort}`} />
      <div aria-hidden="true" className={s.option} />
      <div aria-hidden="true" className={s.option} />
    </div>
  );
}
