const PI_ROOT = "/home/kevin/.vite-plus/packages/@earendil-works/pi-coding-agent/58f82a7b-190b-4214-bb77-229a4ceca622/lib/node_modules";

const ALIASES = {
	"@earendil-works/pi-coding-agent": PI_ROOT + "/@earendil-works/pi-coding-agent/dist/index.js",
	"@earendil-works/pi-agent-core": PI_ROOT + "/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js",
	"@earendil-works/pi-ai/providers/faux": PI_ROOT + "/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js",
	"@earendil-works/pi-ai/compat": PI_ROOT + "/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js",
	"@earendil-works/pi-ai": PI_ROOT + "/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js",
	typebox: PI_ROOT + "/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs",
};

export async function resolve(specifier, context, next) {
	const target = ALIASES[specifier];
	return target ? next(target, context) : next(specifier, context);
}
