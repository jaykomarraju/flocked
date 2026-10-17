// flocked-verify: the CLI over verifyRound / verifyEntry. Exit codes: 0 match, 1 mismatch, 2 unable to
// verify (including bad arguments).
import { readFile } from 'node:fs/promises';
import { parseArgs as parseNodeArgs } from 'node:util';
import { parseDeployment } from '@flocked/abi';
import { chainFromEnv, type DrandChain } from '@flocked/tlock';
import type { Hex } from 'viem';
import type { ChainReader } from './chain.js';
import { dirSource } from './node.js';
import { httpSource } from './source.js';
import type { Report, VerifyRoundOptions } from './types.js';
import { verifyEntry, verifyRound, type EntryReport } from './verify.js';

export const USAGE = `Usage: flocked-verify --round <ulid> --mode <free|stakes> --rpc <url> --chain-id <id> --bundles <url|dir> [options]

Reproduces a Flocked settlement from public data: the bundle, the chain and drand.

  --round <ulid>          the round ID
  --mode <free|stakes>    the mode to verify
  --rpc <url>             JSON-RPC URL of the chain (Base, Base Sepolia, or a local anvil)
  --chain-id <id>         8453, 84532 or 31337
  --bundles <url|dir>     the Flocked API (\${url}/rounds/{roundId}/bundles/{mode}/{file}), or a
                          directory that mirrors the bucket (\${dir}/bundles/{roundId}/{mode}/{file})
  --bucket-layout         read a URL as a bucket mirror (\${url}/bundles/…) instead of the API
  --deployment <file>     a deployments JSON (contracts/deployments/<chainId>.json); required on 31337
  --escrow <0x…> --anchor <0x…> --deploy-block <n>
                          explicit contract addresses, instead of the committed deployment
  --drand-info <url|file> the drand chain's /info JSON; default DRAND_* env vars, else quicknet
  --account <id>          also show one account's entries and payouts with proofs
                          (Free: the userIdHash from your receipt; Stakes: your wallet)
  --json                  print the report as JSON
  --quiet                 no progress on stderr

Exit codes: 0 match, 1 mismatch, 2 unable to verify.`;

export interface CliArgs {
  options: VerifyRoundOptions;
  account: string | null;
  json: boolean;
  quiet: boolean;
}

class UsageError extends Error {}

async function readJsonFrom(where: string): Promise<unknown> {
  if (/^https?:\/\//.test(where)) {
    const res = await fetch(where);
    if (!res.ok) throw new UsageError(`GET ${where}: HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(await readFile(where, 'utf8')) as unknown;
}

/** A drand `/info` document as the chain the picks target. */
export function chainFromInfo(info: unknown): DrandChain {
  const i = info as {
    hash?: unknown;
    public_key?: unknown;
    genesis_time?: unknown;
    period?: unknown;
  };
  const s = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  return chainFromEnv({
    DRAND_CHAIN_HASH: s(i.hash),
    DRAND_PUBLIC_KEY: s(i.public_key),
    DRAND_GENESIS: s(i.genesis_time),
    DRAND_PERIOD: s(i.period),
  });
}

export async function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = {},
): Promise<CliArgs> {
  let values;
  try {
    ({ values } = parseNodeArgs({
      args: argv,
      options: {
        round: { type: 'string' },
        mode: { type: 'string' },
        rpc: { type: 'string' },
        'chain-id': { type: 'string' },
        bundles: { type: 'string' },
        deployment: { type: 'string' },
        escrow: { type: 'string' },
        anchor: { type: 'string' },
        'deploy-block': { type: 'string' },
        'drand-info': { type: 'string' },
        account: { type: 'string' },
        'bucket-layout': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (values.help) throw new UsageError('');
  const need = (k: 'round' | 'mode' | 'rpc' | 'chain-id' | 'bundles') => {
    const v = values[k];
    if (!v) throw new UsageError(`--${k} is required`);
    return v;
  };
  const mode = need('mode');
  if (mode !== 'free' && mode !== 'stakes') throw new UsageError('--mode must be free or stakes');
  const chainId = Number(need('chain-id'));
  if (!Number.isSafeInteger(chainId) || chainId <= 0)
    throw new UsageError('--chain-id must be a positive integer');
  const bundles = need('bundles');
  const options: VerifyRoundOptions = {
    roundId: need('round'),
    mode: mode,
    rpcUrl: need('rpc'),
    chainId,
    bundleBaseUrl: bundles,
    source: /^https?:\/\//.test(bundles)
      ? httpSource(bundles, { layout: values['bucket-layout'] ? 'bucket' : 'api' })
      : dirSource(bundles),
  };
  if (values.deployment) {
    const d = parseDeployment(await readJsonFrom(values.deployment));
    options.addresses = { escrow: d.escrow, anchor: d.anchor, deployBlock: d.deployBlock };
  } else if (values.escrow || values.anchor || values['deploy-block']) {
    const { escrow, anchor } = values;
    const block = values['deploy-block'];
    if (!escrow || !anchor || !block || !/^\d+$/.test(block)) {
      throw new UsageError('--escrow, --anchor and --deploy-block go together');
    }
    options.addresses = {
      escrow: escrow as Hex,
      anchor: anchor as Hex,
      deployBlock: BigInt(block),
    };
  }
  try {
    options.drand = values['drand-info']
      ? chainFromInfo(await readJsonFrom(values['drand-info']))
      : chainFromEnv(env);
  } catch (e) {
    throw new UsageError(`drand chain: ${(e as Error).message}`);
  }
  return { options, account: values.account ?? null, json: values.json, quiet: values.quiet };
}

const MARK = { pass: 'ok  ', fail: 'FAIL', error: 'ERR ', skip: 'skip' } as const;

export function formatReport(r: Report): string {
  const lines = [
    `round ${r.roundId} ${r.mode} on chain ${r.chainId}: ${r.verdict.toUpperCase()}${r.disputed ? ' (disputed anchor)' : ''}`,
  ];
  if (r.bundleHash) lines.push(`bundleHash ${r.bundleHash}, ${r.entryCount ?? 0} entries`);
  if (r.record) {
    const rec = r.record;
    lines.push(
      `record: ${rec.outcome}${rec.refundReason ? ` (rule ${rec.refundReason})` : ''}, winner ${rec.winner ?? '-'}, ` +
        `n ${rec.n[0]}/${rec.n[1]}, w ${rec.w[0]}/${rec.w[1]}, voids ${rec.voidCount}`,
    );
  }
  for (const a of r.anchors) {
    lines.push(
      `anchor ${a.event} by ${a.sender} in ${a.txHash}${a.disputed ? ` DISPUTED: revoked at block ${a.revokedAtBlock}` : ''}`,
    );
  }
  if (r.proposal) {
    const p = r.proposal;
    lines.push(`proposal ${p.status} in ${p.txHash} (round now ${p.onchainStatus})`);
  }
  for (const c of r.checks) {
    lines.push(`${MARK[c.status]} ${c.id}${c.detail ? `: ${c.detail}` : ''}`);
    if (c.status === 'fail' && (c.expected !== undefined || c.actual !== undefined)) {
      lines.push(`       expected ${c.expected ?? '-'}`, `       actual   ${c.actual ?? '-'}`);
    }
  }
  return lines.join('\n');
}

function formatEntry(e: EntryReport, account: string): string {
  const lines = [
    `account ${account}: ${e.entries.length} entr${e.entries.length === 1 ? 'y' : 'ies'}`,
  ];
  for (const x of e.entries) {
    lines.push(
      `  seq ${x.seq}: stake ${x.stake}, ${x.valid ? `option ${x.option}` : `VOID ${x.voidReason}`}`,
    );
  }
  for (const p of e.payouts)
    lines.push(`  payout ${p.kind} ${p.amount}, proof [${p.proof.join(', ')}]`);
  return lines.join('\n');
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x), 2);

/** Runs the CLI; returns the exit code. */
export async function main(
  argv: string[],
  io: {
    out: (s: string) => void;
    err: (s: string) => void;
    env: Record<string, string | undefined>;
  },
  /** Test seam: chain reads from a fake instead of `--rpc`. */
  deps: { reader?: ChainReader } = {},
): Promise<number> {
  let args: CliArgs;
  try {
    args = await parseArgs(argv, io.env);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    if (e.message) io.err(`flocked-verify: ${e.message}`);
    io.err(USAGE);
    return 2;
  }
  if (!args.quiet) args.options.onProgress = (l) => io.err(`… ${l}`);
  if (deps.reader) args.options.reader = deps.reader;
  if (args.account) {
    const e = await verifyEntry({ ...args.options, account: args.account });
    io.out(args.json ? json(e) : `${formatReport(e.report)}\n${formatEntry(e, args.account)}`);
    return e.report.exitCode;
  }
  const r = await verifyRound(args.options);
  io.out(args.json ? json(r) : formatReport(r));
  return r.exitCode;
}
