import type {
  PermissionMode,
  PermissionResponse,
  PermissionRuntimeContext,
} from "../permissions/permissions.js";
import type { TeammateIdentity } from "../teams/types.js";

export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  enum?: string[];
  minLength?: number;
  additionalProperties?: boolean | JSONSchema;
  required?: string[];
  description?: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolContext {
  cwd: string;
  homeDir?: string;
  abortSignal?: AbortSignal;
  permissions?: PermissionRuntimeContext;
  allowedRoots?: string[];
  planFilePath?: string;
  planHomeDir?: string;
  planSessionId?: string;
  sessionId?: string;
  currentMessageId?: string;
  fileHistory?: {
    trackEdit(filePath: string, messageId: string): Promise<void>;
  };
  toolUseId?: string;
  defaultModel?: string;
  availableTools?: Tool[];
  getPermissionMode?: () => PermissionMode;
  setPermissionMode?: (mode: PermissionMode) => void;
  addSessionAllowRules?: (rules: string[]) => void;
  permissionResponse?: PermissionResponse;
  teammateIdentity?: TeammateIdentity;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly maxResultSizeChars?: number;
  call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  isReadOnly(): boolean;
  isEnabled(): boolean;
  isConcurrencySafe?(input?: Record<string, unknown>): boolean;
}
