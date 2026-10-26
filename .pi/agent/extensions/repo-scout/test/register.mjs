/**
 * Resolve pi's own package names for the test run, the way the extension loader does: extensions
 * import the SDK by bare specifier, and the package that provides it is pi's install, not ours.
 *
 * Only needed for modules that import the SDK (`tools.ts` pulls it in through the agent adapter).
 */

import { register } from "node:module";

register("./resolve-pi.mjs", import.meta.url);
