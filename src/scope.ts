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
export function scopesOverlap(left: string, right: string): boolean {
	const a = normalizeScope(left);
	const b = normalizeScope(right);
	return a === '' || b === '' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
export function normalizeScope(path: string): string {
	if (path.trim().length === 0) throw new Error('worker file scope cannot be empty');
	if (path.startsWith('/') || /^[A-Za-z]:/.test(path))
		throw new Error(`worker scope must be workspace-relative: ${path}`);
	const parts = path
		.replaceAll('\\', '/')
		.split('/')
		.filter(part => part && part !== '.');
	if (parts.includes('..')) throw new Error(`invalid worker file scope: ${path}`);
	return parts.join('/');
}
