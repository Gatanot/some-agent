/**
 * Per-tab workspace identity. Each browser tab stores its own workspace id in sessionStorage and
 * sends it with every request so the server keeps an isolated runtime, session, and working
 * directory per tab. `EventSource` cannot set request headers, so the SSE URL carries the id as a
 * query parameter.
 */
const storageKey = "orrery.workspace";

function readStoredId(): string | undefined {
	try {
		return sessionStorage.getItem(storageKey) ?? undefined;
	} catch {
		return undefined;
	}
}

let workspaceId = readStoredId();

export function getWorkspaceId(): string | undefined {
	return workspaceId;
}

export function setWorkspaceId(id: string): void {
	workspaceId = id;
	try {
		sessionStorage.setItem(storageKey, id);
	} catch {
		// Storage can be unavailable; the workspace still works for this visit.
	}
}

export function clearWorkspaceId(): void {
	workspaceId = undefined;
	try {
		sessionStorage.removeItem(storageKey);
	} catch {
		// Storage can be unavailable.
	}
}

export function workspaceFetch(input: string, init?: RequestInit): Promise<Response> {
	const headers = new Headers(init?.headers);
	if (workspaceId) headers.set("x-orrery-workspace", workspaceId);
	return fetch(input, { ...init, headers });
}

export function workspaceEventUrl(path: string): string {
	if (!workspaceId) return path;
	const separator = path.includes("?") ? "&" : "?";
	return `${path}${separator}workspace=${encodeURIComponent(workspaceId)}`;
}
