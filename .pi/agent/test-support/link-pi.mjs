import { join } from "node:path";
import { linkPiInstall } from "./pi-install.mjs";

const extensions = join(import.meta.dir, "..", "extensions");
for (const name of ["background-compaction", "bandar-project-url", "repo-scout", "todos"]) {
	linkPiInstall(join(extensions, name));
}
linkPiInstall(import.meta.dir);
