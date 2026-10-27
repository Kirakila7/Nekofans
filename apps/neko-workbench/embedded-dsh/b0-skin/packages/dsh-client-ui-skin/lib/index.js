/**
 * Host loader entry for the browser-only B0 skin plugin.
 *
 * The package is a client plugin: all behavior lives in lib/client.js, which the
 * web shell serves to the browser. This host half only has to exist so the loader
 * row can mount the package.
 */

/** Provides no host-side behavior. */
export function apply() {}
