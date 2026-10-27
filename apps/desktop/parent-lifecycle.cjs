// A foreground development launcher can request a normal Electron shutdown without
// opening an HTTP control endpoint. Losing that parent must not orphan the pet.
module.exports.installParentLifecycle = (app) => {
  if (!process.connected) return;
  process.on("message", (message) => {
    if (message && message.type === "neko-fish:shutdown") app.quit();
  });
  process.once("disconnect", () => app.quit());
};
