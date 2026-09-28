export type WebToolName = "web_search" | "web_fetch";

export interface WebToolCallRecord {
	readonly schemaVersion: 1;
	readonly toolCallId: string;
	readonly tool: WebToolName;
	readonly timestamp: string;
	readonly suppliedArguments: Readonly<Record<string, unknown>>;
	readonly resolvedArguments: Readonly<Record<string, unknown>>;
}

/** Receives tool-call arguments only. Implementations must not add result content. */
export interface WebToolCallRecorder {
	record(call: WebToolCallRecord): void | Promise<void>;
}

export class InMemoryWebToolCallHistory implements WebToolCallRecorder {
	private readonly calls: WebToolCallRecord[] = [];

	record(call: WebToolCallRecord): void {
		this.calls.push(structuredClone(call));
	}

	list(): WebToolCallRecord[] {
		return structuredClone(this.calls);
	}

	clear(): void {
		this.calls.length = 0;
	}
}

export async function recordWebToolCall(
	recorder: WebToolCallRecorder | undefined,
	call: WebToolCallRecord,
	onError: ((error: Error) => void) | undefined,
): Promise<void> {
	if (!recorder) return;
	try {
		await recorder.record(call);
	} catch (cause) {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		onError?.(error);
	}
}
