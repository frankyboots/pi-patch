/**
 * pi-patch — project extension wiring.
 *
 * Any agent started in this project loads the `patch` tool by default
 * (alongside the built-in `edit`, never instead of it). pi loads
 * `.pi/extensions/` after project trust is granted — expect one trust
 * prompt on first start in this repo.
 *
 * This file is a thin loader; the implementation lives in ../../src
 * (single source of truth — `npm test` / `npm run typecheck` cover it).
 */
export { default } from "../../src/index.js";
