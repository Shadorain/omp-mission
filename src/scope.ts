const GLOB = /[*?[]/;
const UNSAFE_ENCODED = /%(?:2e|2f|5c|00)/i;

export function normalizeRel(path: string): string {
	if (!path || path.includes('\0') || UNSAFE_ENCODED.test(path)) return '';
	if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return '';
	const parts = path.replace(/\\/g, '/').split('/');
	const normalized: string[] = [];
	for (const part of parts) {
		if (!part || part === '.') continue;
		if (part === '..') return '';
		normalized.push(part);
	}
	return normalized.join('/');
}

/** A scope is a file, a directory (prefix), or a glob such as `crates/platform/src/**`. */
export function inScope(path: string, scopes: readonly string[]): boolean {
	const target = normalizeRel(path);
	if (!target) return false;
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
