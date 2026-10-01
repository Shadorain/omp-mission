const GLOB = /[*?[]/;

export function normalizeRel(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** A scope is a file, a directory (prefix), or a glob such as `crates/platform/src/**`. */
export function inScope(path: string, scopes: readonly string[]): boolean {
	const target = normalizeRel(path);
	return scopes.some(raw => {
		const scope = normalizeRel(raw);
		if (!scope) return false;
		if (GLOB.test(scope)) return new Bun.Glob(scope).match(target);
		return target === scope || target.startsWith(`${scope}/`);
	});
}

export function outOfScope(paths: Iterable<string>, scopes: readonly string[]): string[] {
	return [...paths].filter(path => !inScope(path, scopes));
}
