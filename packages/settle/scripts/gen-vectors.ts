// Writes the recorded settlement vectors to vectors/. Deterministic: running it twice gives identical bytes.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateVectors } from './vectors.js';

const dir = join(import.meta.dirname, '../vectors');
for (const [name, contents] of Object.entries(generateVectors())) {
  writeFileSync(join(dir, name), contents);
  console.log(`wrote vectors/${name} (${contents.length} bytes)`);
}
