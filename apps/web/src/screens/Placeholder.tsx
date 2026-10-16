// Screens a later wave builds (Archive, Boards, Rooms, Submit, Queue, Claims, Settings, Profile,
// Round, Verify): the title and an empty-state line until then. And the page for unknown routes.
import { Link } from 'react-router';
import { EmptyState } from '../ui/EmptyState';

/** The line a placeholder screen shows. */
export const PLACEHOLDER_LINE = 'Nothing here yet. The sheep are still building it.';

export function Placeholder({ title }: { title: string }) {
  return (
    <>
      <h1 className="type-title">{title}</h1>
      <EmptyState line={PLACEHOLDER_LINE} />
    </>
  );
}

export function NotFound() {
  return (
    <>
      <h1 className="type-title">Not found</h1>
      <EmptyState
        line="No page here. Even the strays don't wander this far."
        action={
          <Link to="/" className="type-body-strong">
            Back to Today
          </Link>
        }
      />
    </>
  );
}
