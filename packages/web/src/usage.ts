import type { SessionEntry } from "@gatanot/orrery";

export interface UsageModelTotals {
	key: string;
	tokens: number;
	cost: number;
}

export interface UsageDayTotals {
	date: string;
	tokens: number;
	cost: number;
}

export interface UsageSummary {
	models: UsageModelTotals[];
	daily: UsageDayTotals[];
}

/** Structural subset of pi-ai's `Usage` so we do not depend on its nominal export. */
interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

export function localDateKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function entryTime(entry: SessionEntry): number | undefined {
	if (entry.type === "message") {
		const timestamp = (entry.message as { timestamp?: unknown }).timestamp;
		if (typeof timestamp === "number") return timestamp;
	}
	const parsed = Date.parse(entry.timestamp);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/** Mirrors core's `getUsageCostBreakdown` attribution, including its `Tools/summaries` bucket. */
function entryUsage(entry: SessionEntry): { key: string; usage: UsageLike } | undefined {
	if (entry.type === "message") {
		if (entry.message.role === "assistant") {
			const message = entry.message;
			return { key: `${message.provider}/${message.responseModel ?? message.model}`, usage: message.usage };
		}
		if (entry.message.role === "toolResult" && entry.message.usage) {
			return { key: "Tools/summaries", usage: entry.message.usage };
		}
		return undefined;
	}
	if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
		return { key: "Tools/summaries", usage: entry.usage };
	}
	return undefined;
}

function tokensOf(usage: UsageLike): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Aggregate token/cost usage by model and by local day. Entries older than `since` (ms) are
 * ignored. Models with no consumption are omitted.
 */
export function summarizeUsage(entries: SessionEntry[], since?: number): UsageSummary {
	const models = new Map<string, UsageModelTotals>();
	const daily = new Map<string, UsageDayTotals>();

	for (const entry of entries) {
		const time = entryTime(entry);
		if (since !== undefined && (time === undefined || time < since)) continue;
		const extracted = entryUsage(entry);
		if (!extracted) continue;
		const tokens = tokensOf(extracted.usage);
		const cost = extracted.usage.cost.total;
		if (tokens === 0 && cost === 0) continue;

		const model = models.get(extracted.key) ?? { key: extracted.key, tokens: 0, cost: 0 };
		model.tokens += tokens;
		model.cost += cost;
		models.set(extracted.key, model);

		if (time !== undefined) {
			const date = localDateKey(new Date(time));
			const day = daily.get(date) ?? { date, tokens: 0, cost: 0 };
			day.tokens += tokens;
			day.cost += cost;
			daily.set(date, day);
		}
	}

	return {
		models: [...models.values()].sort((a, b) => b.tokens - a.tokens || b.cost - a.cost),
		daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
	};
}
