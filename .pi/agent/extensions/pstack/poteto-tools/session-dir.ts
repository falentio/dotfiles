export type SessionDir = (sessionID: string) => Promise<string>;

export type ToolInput = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type V2Tool = {
  name: string;
  description: string;
  input: ToolInput;
  execute(
    input: never,
    context: { sessionID: string },
  ): Promise<{ content: string }> | { content: string };
};

export function staticSessionDir(directory: string): SessionDir {
  return async () => directory;
}
