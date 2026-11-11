/**
 * Typo-tolerant fuzzy autocomplete for `/` slash commands.
 *
 * Pi's built-in fuzzyFilter requires query characters to appear in strict order,
 * so transpositions or single-letter typos (e.g. `/cancle` for `/schedule-cancel`,
 * `/relaod` for `/reload`, `/compcat` for `/compact`) return no suggestions.
 * This extension stacks an Optimal String Alignment (Damerau-Levenshtein) fallback
 * on top of the built-in autocomplete provider.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

/** Optimal String Alignment distance (supports adjacent transpositions, insertions, deletions, substitutions). */
export function osaDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;

	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	for (let i = 0; i <= m; i++) dp[i][0] = i;
	for (let j = 0; j <= n; j++) dp[0][j] = j;

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let best = Math.min(
				dp[i - 1][j] + 1, // deletion
				dp[i][j - 1] + 1, // insertion
				dp[i - 1][j - 1] + cost, // substitution
			);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				best = Math.min(best, dp[i - 2][j - 2] + 1); // adjacent transposition
			}
			dp[i][j] = best;
		}
	}
	return dp[m][n];
}

function startsSimilarly(query: string, candidate: string): boolean {
	if (!query || !candidate) return false;
	if (query[0] === candidate[0]) return true;
	return query.length >= 2 && candidate.length >= 2 && query[0] === candidate[1] && query[1] === candidate[0];
}

/**
 * Score a command name against a lowercase query using typo-tolerant matching.
 * Returns a numeric score (lower is better), or null if not close enough.
 */
export function scoreTypoMatch(commandName: string, query: string): number | null {
	const q = query.trim().toLowerCase();
	if (q.length < 3) return null;

	const maxDist = q.length <= 5 ? 1 : 2;
	const rawLower = commandName.toLowerCase();
	const bareName = rawLower.startsWith("skill:") ? rawLower.slice("skill:".length) : rawLower;
	const segments = bareName.split(/[-_.:/]+/).filter(Boolean);

	let bestScore: number | null = null;
	const consider = (candidate: string, penalty: number) => {
		if (!startsSimilarly(q, candidate)) return;
		if (Math.abs(candidate.length - q.length) > maxDist) return;
		const dist = osaDistance(q, candidate);
		if (dist > maxDist) return;
		const score = dist * 10 + penalty + Math.abs(candidate.length - q.length);
		if (bestScore === null || score < bestScore) {
			bestScore = score;
		}
	};

	// 1. Full bare command name and its prefixes around query length
	consider(bareName, 0);
	for (const len of [q.length - 1, q.length, q.length + 1]) {
		if (len >= 3 && len < bareName.length) {
			consider(bareName.slice(0, len), 2);
		}
	}

	// 2. Individual segments (e.g. "cancel" in "schedule-cancel") and their prefixes
	segments.forEach((seg, idx) => {
		const segPenalty = idx === 0 ? 1 : 3;
		consider(seg, segPenalty);
		for (const len of [q.length - 1, q.length, q.length + 1]) {
			if (len >= 3 && len < seg.length) {
				consider(seg.slice(0, len), segPenalty + 2);
			}
		}
	});

	return bestScore;
}

export function wrapTypoTolerantAutocomplete(current: AutocompleteProvider): AutocompleteProvider {
	return {
		triggerCharacters: current.triggerCharacters,
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const commandText = textBeforeCursor.trimStart();

			if (
				options.force ||
				!commandText.startsWith("/") ||
				commandText.includes(" ") ||
				commandText.slice(1).includes("/")
			) {
				return base;
			}

			const query = commandText.slice(1).trim().toLowerCase();
			if (query.length < 3) return base;

			const all = await current.getSuggestions(["/"], 0, 1, { signal: options.signal, force: false });
			if (!all?.items?.length) return base;

			const existingValues = new Set((base?.items ?? []).map((item) => item.value));
			const typoMatches: Array<{ item: AutocompleteItem; score: number }> = [];

			for (const item of all.items) {
				if (existingValues.has(item.value)) continue;
				const score = scoreTypoMatch(item.value, query);
				if (score !== null) {
					typoMatches.push({ item, score });
				}
			}

			if (typoMatches.length === 0) return base;
			typoMatches.sort((a, b) => a.score - b.score || a.item.value.localeCompare(b.item.value));

			return {
				prefix: base?.prefix ?? commandText,
				items: [...(base?.items ?? []), ...typoMatches.map((entry) => entry.item)],
			};
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function fuzzySlashAutocomplete(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) => wrapTypoTolerantAutocomplete(current));
	});
}
