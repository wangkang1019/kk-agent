import { asString } from "./frontmatter.js";
import {
  getProjectSettingsPath,
  getUserSettingsPath,
  isProjectTrusted,
  loadSettings,
  writeSetting,
} from "../../config/index.js";

export interface ExtensionSettings {
  outputStyle?: string;
}

export async function readMergedExtensionSettings(params: {
  cwd: string;
  homeDir?: string;
}): Promise<ExtensionSettings> {
  const trusted = await isProjectTrusted(params);
  const loaded = await loadSettings({
    cwd: params.cwd,
    homeDir: params.homeDir,
    includeUntrustedProject: trusted,
  });
  const outputStyle = asString(loaded.settings.outputStyle);

  return {
    ...(outputStyle && { outputStyle }),
  };
}

export async function writeUserExtensionSetting(params: {
  homeDir?: string;
  key: "outputStyle";
  value: string;
}): Promise<void> {
  await writeSetting({
    cwd: process.cwd(),
    homeDir: params.homeDir,
    scope: "user",
    key: params.key,
    value: params.value,
  });
}

export { getProjectSettingsPath, getUserSettingsPath };
