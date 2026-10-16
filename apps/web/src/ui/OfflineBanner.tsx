// The offline banner (Paper Components › Feedback › Offline banner): an ink band under the mobile
// header with the offline icon and VOICE.offline. It pushes content down and never covers it; it is
// not dismissible. On desktop it spans the content column. A polite live region.
import { VOICE } from '@flocked/shared';
import { OfflineIcon } from './icons/OfflineIcon';
import s from './OfflineBanner.module.css';

export interface OfflineBannerProps {
  message?: string;
  className?: string;
}

export function OfflineBanner({ message = VOICE.offline, className }: OfflineBannerProps) {
  return (
    <div role="status" className={className ? `${s.banner} ${className}` : s.banner}>
      <OfflineIcon className={s.icon} />
      <p className={`type-label ${s.message}`}>{message}</p>
    </div>
  );
}
