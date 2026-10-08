// Types for scripts/gen.mjs, imported by the tests.

export declare const ROOT: string;
export declare const CONTRACTS: readonly { file: string; artifact: string; name: string }[];
export declare const COMMITTED_CHAINS: readonly number[];
export declare function inputFiles(root?: string): string[];
export declare function inputsHash(root?: string): string;
export declare function recordedHash(source: string): string | undefined;
export declare function generate(root?: string): { hash: string; files: Record<string, string> };
