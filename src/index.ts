/**
 * @smplkit/browser — read feature flags and configuration in the
 * browser with a publishable key.
 *
 * ```ts
 * import { SmplClient, Context } from "@smplkit/browser";
 *
 * const smpl = new SmplClient({ apiKey: "sk_public_..." });
 * await smpl.waitUntilReady();
 *
 * smpl.setContext([new Context("user", "u_1", { plan: "pro" })]);
 *
 * if (smpl.flags.booleanFlag("dark-mode", false).get()) {
 *   // ...
 * }
 * const settings = await smpl.config.subscribe("web-app");
 * ```
 */

export { SmplClient, type SmplClientOptions } from "./client.js";
export { Context } from "./context.js";
export { Flag, BooleanFlag, StringFlag, NumberFlag, JsonFlag, FlagsNamespace } from "./flags.js";
export { ConfigNamespace, LiveConfigProxy } from "./config.js";
export type {
  FlagChangeEvent,
  ConfigChangeEvent,
  FlagChangeListener,
  ConfigChangeListener,
} from "./store.js";
export type { BootstrapOption, BootstrapPayload } from "./bootstrap.js";
export type { ConnectionStatus } from "./transport.js";
export {
  SmplError,
  SmplTimeoutError,
  SmplNotFoundError,
  SmplkitError,
  SmplkitTimeoutError,
  SmplkitNotFoundError,
} from "./errors.js";
