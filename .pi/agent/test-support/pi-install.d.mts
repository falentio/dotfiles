export function findPiInstall(): string;
export function piCommand(root?: string): string[];
export function piAliases(root?: string): Record<string, string>;
export function linkPiInstall(target: string): string;
