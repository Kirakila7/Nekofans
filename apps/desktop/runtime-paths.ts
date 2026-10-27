import { resolve } from "node:path";

/** Packaged apps are self-contained; inherited development overrides must not
 * silently reconnect a moved portable folder to the original source sandbox. */
export function desktopRuntimePaths(options: {
  repositoryRoot: string;
  packaged: boolean;
  resourcesPath?: string;
  env?: NodeJS.ProcessEnv;
}) {
  if (options.packaged) {
    if (!options.resourcesPath) throw new Error("Application resources are unavailable.");
    return {
      assetsDir: resolve(options.resourcesPath, "assets"),
      dshRuntimeDir: resolve(options.resourcesPath, "dsh"),
      primaryRuntimeDir: resolve(options.resourcesPath, "primary-runtime"),
    };
  }
  const env = options.env ?? process.env;
  const sandbox = resolve(options.repositoryRoot, "../_sandbox/f01-dsh-desktop");
  return {
    assetsDir: env.NEKO_FISH_ASSETS_DIR || resolve(options.repositoryRoot, "assets"),
    dshRuntimeDir: env.NEKO_FISH_DSH_RUNTIME || resolve(sandbox, "src/apps/desktop/.desktop-build/development/project"),
    primaryRuntimeDir: env.NEKO_FISH_DSH_PRIMARY_RUNTIME || resolve(sandbox, "primary-runtime-stub/primary-runtime"),
  };
}
