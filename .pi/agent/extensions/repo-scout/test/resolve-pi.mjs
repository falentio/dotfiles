import { findPiInstall, piAliases } from "../../../test-support/pi-install.mjs";

const ALIASES = piAliases(findPiInstall());

export async function resolve(specifier, context, next) {
	const target = ALIASES[specifier];
	return target ? next(target, context) : next(specifier, context);
}
