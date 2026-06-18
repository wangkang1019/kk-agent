export interface SandboxFilesystemSettings {
  allowRead: string[];
  denyRead: string[];
  allowWrite: string[];
  denyWrite: string[];
}

export interface SandboxNetworkSettings {
  allow: boolean;
  allowedDomains: string[];
  deniedDomains: string[];
}

export interface SandboxSettings {
  enabled: boolean;
  autoAllowBashIfSandboxed: boolean;
  allowUnsandboxedCommands: boolean;
  excludedCommands: string[];
  filesystem: SandboxFilesystemSettings;
  network: SandboxNetworkSettings;
}

export type SandboxRuntimeKind =
  | "macos-sandbox-exec"
  | "windows-unsupported"
  | "unsupported";

export interface SandboxRuntimeStatus {
  platform: NodeJS.Platform | string;
  supported: boolean;
  available: boolean;
  kind: SandboxRuntimeKind;
  reason?: string;
}

export interface SandboxProfile {
  filesystem: SandboxFilesystemSettings;
  network: SandboxNetworkSettings;
}

export interface PreparedSandboxCommand {
  command: string;
  sandboxed: boolean;
  status: "enabled" | "disabled" | "unavailable";
  runtime: SandboxRuntimeStatus;
  settings: SandboxSettings;
  profile?: SandboxProfile;
  reason?: string;
  blocked?: boolean;
}

export interface PrepareBashCommandParams {
  command: string;
  cwd: string;
  dangerouslyDisableSandbox?: boolean;
  homeDir?: string;
  platform?: NodeJS.Platform | string;
}
