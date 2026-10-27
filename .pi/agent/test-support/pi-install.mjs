import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PACKAGE = join("@earendil-works", "pi-coding-agent");

// vite-plus keeps one hash directory per install; the newest dist is the running one.
function newest(paths) {
	return paths
		.filter((path) => existsSync(join(path, "dist", "index.js")))
		.sort((a, b) => statSync(join(b, "dist", "index.js")).mtimeMs - statSync(join(a, "dist", "index.js")).mtimeMs)[0];
}

export function findPiInstall() {
	if (process.env.PI_INSTALL) return process.env.PI_INSTALL;

	const versions = join(homedir(), ".vite-plus", "packages", PACKAGE);
	if (existsSync(versions)) {
		const installed = readdirSync(versions)
			.filter((name) => !name.endsWith(".lock"))
			.map((name) => join(versions, name, "lib", "node_modules", PACKAGE));
		const found = newest(installed);
		if (found) return found;
	}

	const bunGlobal = join(homedir(), ".bun", "install", "global", "node_modules", PACKAGE);
	if (existsSync(join(bunGlobal, "dist", "index.js"))) return bunGlobal;

	throw new Error("Cannot find @earendil-works/pi-coding-agent. Set PI_INSTALL to its package directory.");
}

export function piAliases(root = findPiInstall()) {
	const ai = join(root, "node_modules", "@earendil-works", "pi-ai", "dist");
	return {
		"@earendil-works/pi-coding-agent": join(root, "dist", "index.js"),
		"@earendil-works/pi-ai/compat": join(ai, "compat.js"),
		"@earendil-works/pi-ai": join(ai, "compat.js"),
		"@earendil-works/pi-ai/providers/faux": join(ai, "providers", "faux.js"),
		"@earendil-works/pi-agent-core": join(root, "node_modules", "@earendil-works", "pi-agent-core", "dist", "index.js"),
		"@earendil-works/pi-tui": join(root, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
		typebox: join(root, "node_modules", "typebox", "build", "index.mjs"),
	};
}

export function linkPiInstall(target) {
	const root = findPiInstall();
	const modules = join(target, "node_modules");
	mkdirSync(join(modules, "@earendil-works"), { recursive: true });

	const links = [
		[join(modules, "@earendil-works", "pi-coding-agent"), root],
		[join(modules, "@earendil-works", "pi-ai"), join(root, "node_modules", "@earendil-works", "pi-ai")],
		[join(modules, "@earendil-works", "pi-agent-core"), join(root, "node_modules", "@earendil-works", "pi-agent-core")],
		[join(modules, "@earendil-works", "pi-tui"), join(root, "node_modules", "@earendil-works", "pi-tui")],
		[join(modules, "typebox"), join(root, "node_modules", "typebox")],
	];

	for (const [link, source] of links) {
		if (!existsSync(source)) continue;
		// A dangling symlink from an older install throws here; remove it and relink.
		try {
			if (realpathSync(link) === realpathSync(source)) continue;
		} catch {}
		try {
			const stat = lstatSync(link);
			if (stat.isDirectory() && !stat.isSymbolicLink()) rmSync(link, { recursive: true, force: true });
			else unlinkSync(link);
		} catch {}
		symlinkSync(source, link, "dir");
	}
	return root;
}
