// Writes vectors/target-round.json. Deterministic: running it twice gives identical bytes.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateVectors } from './vectors.js';

const contents = generateVectors();
writeFileSync(join(import.meta.dirname, '../vectors/target-round.json'), contents);
console.log(`wrote vectors/target-round.json (${contents.length} bytes)`);
