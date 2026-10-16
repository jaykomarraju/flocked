import type { TabId } from '../routes';

export function Placeholder({ title }: { tab: TabId | null; title: string }) {
  return <h1 className="type-title">{title}</h1>;
}

export function NotFound() {
  return <h1 className="type-title">Not found</h1>;
}
