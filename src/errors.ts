/**
 * Error hierarchy, mirroring the names in `@smplkit/sdk`.
 */

/** Base error for everything thrown by this SDK. */
export class SmplError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A deadline elapsed — thrown by `waitUntilReady`. */
export class SmplTimeoutError extends SmplError {}

/** A referenced resource does not exist — thrown by `config.subscribe`. */
export class SmplNotFoundError extends SmplError {}

// Dual naming, mirroring the server SDK's Smpl* / Smplkit* aliases.
export {
  SmplError as SmplkitError,
  SmplTimeoutError as SmplkitTimeoutError,
  SmplNotFoundError as SmplkitNotFoundError,
};
