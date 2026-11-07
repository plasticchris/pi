/**
 * Test-time self-improvement tracking (the "score boundary").
 *
 * AREX-2-style agents refine a solution over many rounds; the useful harness
 * primitive is a cheap, typed signal of *verifiable progress* per round. This
 * module is that signal, as a pure observer over tool results: it recognizes
 * `score` tool results, tracks the best-so-far curve, and reports T* — the
 * number of scored rounds that produced a strict improvement before the curve
 * stalled. It carries no model/loop dependencies so it is unit-testable in
 * isolation and reusable by any harness (pi sessions, forge works, eval runners).
 */

export interface ScoreObservation {
	/** Monotonic round index within the current task (0-based). */
	round: number;
	/** The reported metric value (higher is better). */
	score: number;
	/** Best score seen through this round, inclusive. */
	best: number;
	/** True when this round strictly improved on the previous best. */
	improved: boolean;
	/** Tool result id, for correlation with the transcript. */
	toolCallId?: string;
	/** Wall-clock timestamp of the observation. */
	timestamp: number;
}

export interface SelfImprovementSummary {
	/** Total scored rounds observed for the current task. */
	rounds: number;
	/** Best score observed, or null when no score was seen. */
	best: number | null;
	/**
	 * T*: rounds that strictly improved the best-so-far. A short T* relative to
	 * `rounds` means the model stalled early; a long T* means the budget is being
	 * spent productively.
	 */
	productiveRounds: number;
	/** The full best-so-far curve, in observation order. */
	observations: ScoreObservation[];
}

/**
 * Observer that folds `score` tool results into a per-task improvement curve.
 * Call {@link observe} for every tool result; non-score results are ignored.
 * Call {@link reset} at task boundaries (e.g. each new user turn).
 */
export class SelfImprovementTracker {
	private observations: ScoreObservation[] = [];
	private best: number | null = null;

	/**
	 * Fold one tool result into the curve. Returns the observation when the
	 * result is a score, otherwise undefined. A score result is identified by
	 * `toolName === "score"` with a numeric `details.score`.
	 */
	observe(result: { toolName?: string; toolCallId?: string; details?: unknown }): ScoreObservation | undefined {
		if (!result || result.toolName !== "score") return undefined;
		const score = (result.details as { score?: unknown } | undefined)?.score;
		if (typeof score !== "number" || !Number.isFinite(score)) return undefined;

		const previousBest = this.best;
		const improved = previousBest === null || score > previousBest;
		if (improved) this.best = score;

		const observation: ScoreObservation = {
			round: this.observations.length,
			score,
			best: this.best as number,
			improved,
			toolCallId: result.toolCallId,
			timestamp: Date.now(),
		};
		this.observations.push(observation);
		return observation;
	}

	/** Snapshot the current task's curve. */
	summary(): SelfImprovementSummary {
		return {
			rounds: this.observations.length,
			best: this.best,
			productiveRounds: this.observations.filter((o) => o.improved).length,
			observations: [...this.observations],
		};
	}

	/** Start a new task's curve. */
	reset(): void {
		this.observations = [];
		this.best = null;
	}
}
