#!/usr/bin/env node
// Checks that every external function and event of the audited contracts has NatSpec: a @notice, a @param for each
// named input and a @return for each output. Reads solc's userdoc/devdoc from the Foundry build output, so run
// `forge build` first. Public state variables (constants, immutables, mappings) count as external functions; solc
// only lets them carry a @notice (and @inheritdoc), so for their getters a @notice is enough.
//
//   node tools/check-natspec.mjs        (from contracts/) exit 1 and list the gaps if any doc is missing

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'out');
const CONTRACTS = ['FlockedEscrow.sol/FlockedEscrow.json', 'FlockedAnchor.sol/FlockedAnchor.json'];

// Inherited unchanged from OpenZeppelin, which documents them in its own sources.
const INHERITED = new Set([
  'DEFAULT_ADMIN_ROLE()',
  'eip712Domain()',
  'getRoleAdmin(bytes32)',
  'getRoleMember(bytes32,uint256)',
  'getRoleMemberCount(bytes32)',
  'getRoleMembers(bytes32)',
  'hasRole(bytes32,address)',
  'paused()',
  'supportsInterface(bytes4)',
  'renounceRole(bytes32,address)@FlockedAnchor',
  'revokeRole(bytes32,address)@FlockedAnchor',
  'EIP712DomainChanged()',
  'Paused(address)',
  'Unpaused(address)',
  'RoleAdminChanged(bytes32,bytes32,bytes32)',
  'RoleGranted(bytes32,address,address)',
  'RoleRevoked(bytes32,address,address)',
]);

const type = (p) =>
  p.type.startsWith('tuple')
    ? `(${p.components.map(type).join(',')})${p.type.slice('tuple'.length)}`
    : p.type;
const signature = (item) => `${item.name}(${item.inputs.map(type).join(',')})`;

const gaps = [];
for (const artifact of CONTRACTS) {
  const json = JSON.parse(readFileSync(join(OUT, artifact), 'utf8'));
  const name = artifact.split('/').pop().replace('.json', '');
  // Foundry's parsed `metadata` drops event docs; solc's raw metadata keeps them.
  const { userdoc, devdoc } = JSON.parse(json.rawMetadata).output;
  const getters = publicStateVariables(readFileSync(join(ROOT, 'src', `${name}.sol`), 'utf8'));
  for (const item of json.abi) {
    if (item.type !== 'function' && item.type !== 'event') continue;
    const sig = signature(item);
    if (INHERITED.has(sig) || INHERITED.has(`${sig}@${name}`)) continue;
    const kind = item.type === 'function' ? 'methods' : 'events';
    const user = userdoc[kind]?.[sig] ?? {};
    const dev = devdoc[kind]?.[sig] ?? {};
    const where = `${name}.${sig}`;
    if (!user.notice) gaps.push(`${where}: no @notice`);
    if (item.type === 'function' && getters.has(item.name)) continue;
    for (const input of item.inputs) {
      if (input.name && !dev.params?.[input.name]) gaps.push(`${where}: no @param ${input.name}`);
    }
    if (item.type === 'function' && Object.keys(dev.returns ?? {}).length < item.outputs.length) {
      gaps.push(`${where}: no @return`);
    }
  }
}

/** Names of the public state variables declared in a contract's source (Foundry artifacts carry no AST). */
function publicStateVariables(source) {
  const decl = /^\s*(?:mapping\(.*\)|[\w.]+)\s+public\s+(?:constant\s+|immutable\s+)?(\w+)/gm;
  return new Set([...source.matchAll(decl)].map((m) => m[1]));
}

if (gaps.length > 0) {
  console.error(`NatSpec gaps (${gaps.length}):\n  ${gaps.join('\n  ')}`);
  process.exit(1);
}
console.log('NatSpec complete on every external function and event');
