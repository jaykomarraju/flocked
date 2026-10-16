// A route that failed to render (spec "Client app"; Paper Components › Feedback › Error): the
// unexpected-error box, VOICE.error with "Retry", which loads the page again. Inside the shell it
// takes the screen's place; when the shell itself fails (`standalone`) it is the whole page.
import { useRouteError } from 'react-router';
import { ErrorBox } from '../ui/ErrorBox';
import s from './RouteError.module.css';

export function RouteError({ standalone = false }: { standalone?: boolean }) {
  const error = useRouteError();
  if (import.meta.env.DEV && error) console.error(error);
  const box = <ErrorBox onRetry={() => window.location.reload()} />;
  return standalone ? <main className={s.page}>{box}</main> : box;
}
