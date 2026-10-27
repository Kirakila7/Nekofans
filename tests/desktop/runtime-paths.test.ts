import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { desktopRuntimePaths } from "../../apps/desktop/runtime-paths.ts";

test("portable resource paths are rooted in the moved package and ignore inherited dev settings", () => {
  const resourcesPath = resolve("relocated portable/resources");
  const paths = desktopRuntimePaths({ repositoryRoot: join(resourcesPath, "app"), resourcesPath, packaged: true,
    env: { NEKO_FISH_ASSETS_DIR: "old-assets", NEKO_FISH_DSH_RUNTIME: "old-host", NEKO_FISH_DSH_PRIMARY_RUNTIME: "old-primary" } });
  assert.deepEqual(paths, { assetsDir: join(resourcesPath, "assets"), dshRuntimeDir: join(resourcesPath, "dsh"), primaryRuntimeDir: join(resourcesPath, "primary-runtime") });
  assert.throws(() => desktopRuntimePaths({ repositoryRoot: ".", packaged: true }), /resources/);
});

test("development runtime retains explicit overrides and existing workspace fallback", () => {
  const paths = desktopRuntimePaths({ repositoryRoot: resolve("workspace/repo"), packaged: false, env: {} });
  assert.equal(paths.assetsDir, resolve("workspace/repo/assets"));
  assert.equal(paths.dshRuntimeDir, resolve("workspace/_sandbox/f01-dsh-desktop/src/apps/desktop/.desktop-build/development/project"));
  assert.deepEqual(desktopRuntimePaths({ repositoryRoot: ".", packaged: false,
    env: { NEKO_FISH_ASSETS_DIR: "assets", NEKO_FISH_DSH_RUNTIME: "host", NEKO_FISH_DSH_PRIMARY_RUNTIME: "primary" } }),
    { assetsDir: "assets", dshRuntimeDir: "host", primaryRuntimeDir: "primary" });
});
