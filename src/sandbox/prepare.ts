import { loadSandboxSettings } from "./settings.js";
import { buildSandboxProfile, compileMacosSandboxProfile, shellQuote } from "./profile.js";
import { getSandboxRuntimeStatus, shouldUseSandbox } from "./runtime.js";
import type {
  PrepareBashCommandParams,
  PreparedSandboxCommand,
} from "./types.js";

export async function prepareBashCommand(
  params: PrepareBashCommandParams,
): Promise<PreparedSandboxCommand> {
  const settings = await loadSandboxSettings({
    cwd: params.cwd,
    ...(params.homeDir && { homeDir: params.homeDir }),
  });
  const runtime = getSandboxRuntimeStatus({
    ...(params.platform && { platform: params.platform }),
  });
  const wantsSandbox = settings.enabled && !params.dangerouslyDisableSandbox;

  if (wantsSandbox && !runtime.available) {
    return {
      command: params.command,
      sandboxed: false,
      status: "unavailable",
      runtime,
      settings,
      reason: runtime.reason ?? "Sandbox runtime is unavailable.",
      blocked: !settings.allowUnsandboxedCommands,
    };
  }

  if (
    shouldUseSandbox(
      {
        command: params.command,
        dangerouslyDisableSandbox: params.dangerouslyDisableSandbox,
      },
      settings,
      runtime,
    )
  ) {
    const profile = buildSandboxProfile({ cwd: params.cwd, settings });

    if (runtime.kind === "macos-sandbox-exec") {
      const compiledProfile = compileMacosSandboxProfile(profile);
      return {
        command: `/usr/bin/sandbox-exec -p ${shellQuote(compiledProfile)} /bin/bash -lc ${shellQuote(params.command)}`,
        sandboxed: true,
        status: "enabled",
        runtime,
        settings,
        profile,
      };
    }
  }

  return {
    command: params.command,
    sandboxed: false,
    status: "disabled",
    runtime,
    settings,
  };
}
