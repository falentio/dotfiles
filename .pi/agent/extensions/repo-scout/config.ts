/**
 * Repo-scout settings. This file is the only settings source: no config file or
 * settings environment variable is read.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ScoutConfig {
	/** Root of the checkouts, transcripts, and locks. */
	stateRoot: string;
	/** A conversation idle this long is evicted. */
	idleMs: number;
	/** One turn's ceiling. */
	turnMs: number;
	/** How long a second process waits for the repo lock. */
	lockWaitMs: number;
}

export const SCOUT_CONFIG: Readonly<ScoutConfig> = {
	stateRoot: join(homedir(), '.pi', 'scout'),
	idleMs: 3_600_000,
	turnMs: 900_000,
	lockWaitMs: 600_000,
};
