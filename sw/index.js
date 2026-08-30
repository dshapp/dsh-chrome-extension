/**
 * Service worker entry: assembly only.
 *
 * Two independent halves share one worker:
 *   - the CDP bridge (../background.js), untouched and self-registering;
 *   - the DSH side panel support, split across the shards below.
 *
 * The bridge is imported rather than merged so that background.js stays a
 * standalone, unmodified file (its test suite evaluates that source directly).
 * ES module imports are hoisted and run before this module's body, so every
 * listener each shard registers is attached synchronously at worker startup,
 * as MV3 requires.
 */

import "../background.js";

import "./sidepanel-open.js";
import "./fence-rules-sync.js";
import "./session-notify.js";
import "./picker-presence.js";
import "./server-supervisor.js";
