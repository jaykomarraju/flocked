// Self-hosted fonts (Design_Language.md "Typography"; wave-8.md "Screenshot tests": pinned files).
// The families come from design-tokens.json; these are the variable font files Vite bundles into
// dist/assets, pinned by the @fontsource-variable package versions in package.json. "standard" files
// carry every axis Paper uses: Inter wght + opsz (optical size on auto), Fredoka wght + wdth.
import fredokaLatinExt from '@fontsource-variable/fredoka/files/fredoka-latin-ext-standard-normal.woff2?url';
import fredokaLatin from '@fontsource-variable/fredoka/files/fredoka-latin-standard-normal.woff2?url';
import interLatinExt from '@fontsource-variable/inter/files/inter-latin-ext-standard-normal.woff2?url';
import interLatin from '@fontsource-variable/inter/files/inter-latin-standard-normal.woff2?url';

/** One woff2 file of a variable family: its weight range and the code points it covers. */
export interface FontFile {
  url: string;
  weight: [number, number];
  unicodeRange: string;
}

// Unicode ranges as @fontsource publishes them (its standard.css).
const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

/** Files per token font role (`font.display`, `font.body`; `numeric` is the body family). */
export const FONT_FILES: Record<'display' | 'body', FontFile[]> = {
  display: [
    { url: fredokaLatinExt, weight: [300, 700], unicodeRange: LATIN_EXT },
    { url: fredokaLatin, weight: [300, 700], unicodeRange: LATIN },
  ],
  body: [
    { url: interLatinExt, weight: [100, 900], unicodeRange: LATIN_EXT },
    { url: interLatin, weight: [100, 900], unicodeRange: LATIN },
  ],
};
