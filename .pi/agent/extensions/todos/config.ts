/**
 * Todos extension settings.
 *
 * This file is the only config source. No JSON file, environment variable,
 * or CLI flag is read.
 */

export type TodoEagerMode = "default" | "preferred" | "always";

export interface TodoConfig {
	/** Gates the todo tool's availability and every tracker behavior. */
	enabled: boolean;
	/** Stop-time incomplete-todo reminders. */
	reminders: boolean;
	/** Max reminder attempts per prompt cycle. */
	remindersMax: number;
	/** First-turn eager prelude mode. */
	eager: TodoEagerMode;
}

export const TODO_CONFIG: Readonly<TodoConfig> = {
	enabled: true,
	reminders: true,
	remindersMax: 3,
	eager: "preferred",
};
