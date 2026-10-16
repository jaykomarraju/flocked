// /__sheets/<surface>/<screen>/<state>/<breakpoint>: one artboard, drawn by its sheet module
// (`*.sheet.tsx` under src/sheets). The page has no app chrome; the sheet draws everything the
// artboard shows. `data-sheet-ready` tells the screenshot helper that the sheet and its fonts are in.
import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import type { SheetBreakpoint, SheetDef } from './types';

const modules = import.meta.glob<{ default: SheetDef }>('./**/*.sheet.tsx');

/** Sheet module path → its definition loader, keyed by the sheet name. */
async function loadSheet(name: string): Promise<SheetDef | null> {
  for (const load of Object.values(modules)) {
    const def = (await load()).default;
    if (def.name === name) return def;
  }
  return null;
}

/** Every sheet's artboards, for the index page. */
export async function listArtboards(): Promise<string[]> {
  const defs = await Promise.all(
    Object.values(modules).map(async (load) => (await load()).default),
  );
  return defs.flatMap((d) => d.artboards.map((a) => `${d.name}/${a}`)).sort();
}

export function SheetPage() {
  const { surface = '', screen = '', state = '', breakpoint = '' } = useParams();
  const [content, setContent] = useState<ReactNode>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void loadSheet(`${surface}/${screen}`).then(async (def) => {
      if (!live) return;
      if (!def || !def.artboards.includes(`${state}/${breakpoint}`)) {
        setError(`No sheet for ${surface}/${screen}/${state}/${breakpoint}`);
        return;
      }
      setContent(def.render(state, breakpoint as SheetBreakpoint));
      await document.fonts.ready;
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, [surface, screen, state, breakpoint]);

  if (error) return <p role="alert">{error}</p>;
  return <div data-sheet-ready={ready ? 'true' : undefined}>{content}</div>;
}

export function SheetIndex() {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    void listArtboards().then(setNames);
  }, []);
  return (
    <main style={{ padding: 24 }}>
      <h1>Design sheets</h1>
      <ul>
        {names.map((n) => (
          <li key={n}>
            <a href={`/__sheets/${n}`}>{n}</a>
          </li>
        ))}
      </ul>
    </main>
  );
}
