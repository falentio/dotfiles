import { join } from "node:path";
import { linkPiInstall } from "./pi-install.mjs";

const extensions = join(import.meta.dir, "..", "extensions");
for (const name of ["background-compaction", "repo-scout", "todos"]) {
	linkPiInstall(join(extensions, name));
}
