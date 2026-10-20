/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fixnooc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Picks which model should answer a request, by asking TypeSafe's Jev how much
 * work the request actually is.
 *
 * Jev returns the judgment; the tier policy below is ordinary code, so changing
 * which model serves a tier costs nothing and does not re-run inference.
 */

const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';

/**
 * Levels describe concrete situations rather than degrees, because the model
 * judges each one on its own and never sees their numbers or its neighbours.
 */
const WEIGHT_LEVELS = [
	'A direct question about syntax, a definition, or a short explanation, answerable without looking at the project',
	'A small change confined to one file, such as renaming a symbol, correcting a typo, or adding a short self-contained function',
	'A change across a few files whose requirements are already clear, such as threading a parameter through a call chain or writing tests for code that exists',
	'A feature or bug that needs unfamiliar code read and understood first to work out what to change, across several files',
	'A design decision that shapes the architecture, or a problem whose correct approach is not yet known and has to be worked out',
];

/** Which tier serves which level of the scale above. */
const TIER_BY_LEVEL = ['small', 'small', 'medium', 'large', 'large'];

/**
 * Below this, Jev's probabilities are spread across levels rather than settled
 * on one. A split judgment moves up a tier: answering a hard request with a
 * small model wastes the turn, while the reverse only costs tokens.
 */
const CONFIDENCE_FLOOR = 0.5;

const TIER_ORDER = ['small', 'medium', 'large'];

/**
 * @param {string} prompt The user's latest message.
 * @param {object} config
 * @param {string} config.apiKey TypeSafe API key.
 * @param {string} [config.judgeModel] Jev model or alias.
 * @param {Record<string, string>} config.models Model name per tier.
 * @param {string} [config.fallbackTier] Tier to use when judging is unavailable.
 * @returns {Promise<{model: string, tier: string, weight: number|null, confidence: number|null, needsProjectContext: number|null, judged: boolean, note?: string}>}
 */
export async function pickModel(prompt, config) {
	const fallbackTier = config.fallbackTier || 'medium';

	if (!config.apiKey) {
		return unjudged(config, fallbackTier, 'no TypeSafe API key configured');
	}

	let answers;
	try {
		answers = await askJev(prompt, config);
	} catch (error) {
		// Routing is an optimisation; never let it take the whole request down.
		return unjudged(config, fallbackTier, `judging failed: ${error.message}`);
	}

	const weight = answers.weight;
	const level = clamp(Math.round(weight?.score ?? 0), 0, WEIGHT_LEVELS.length - 1);
	const confidence = typeof weight?.confidence === 'number' ? weight.confidence : null;

	let tier = TIER_BY_LEVEL[level];
	let note;
	if (confidence !== null && confidence < CONFIDENCE_FLOOR) {
		const raised = nextTierUp(tier);
		if (raised !== tier) {
			note = `confidence ${confidence.toFixed(2)} below ${CONFIDENCE_FLOOR}, raised from ${tier}`;
			tier = raised;
		}
	}

	return {
		model: modelForTier(config, tier, fallbackTier),
		tier,
		weight: typeof weight?.score === 'number' ? weight.score : null,
		confidence,
		needsProjectContext: typeof answers.needsProjectContext?.noul === 'number'
			? answers.needsProjectContext.noul
			: null,
		judged: true,
		note,
	};
}

/**
 * Both questions are independent and read the same state, so they go in one
 * request and are answered in parallel.
 */
async function askJev(prompt, config) {
	const response = await fetch(SYSTEM_ONE_URL, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${config.apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: config.judgeModel || 'jev-latest',
			state: { request: prompt },
			questions: {
				weight: {
					type: 'score',
					instructions: 'How much work does answering `request` take for a software developer?',
					criteria: WEIGHT_LEVELS,
				},
				needsProjectContext: {
					type: 'noul',
					instructions: 'Does answering `request` require reading this specific project\'s own code?',
					criteria: {
						true: 'The answer depends on how this particular codebase is written',
						false: 'The answer is general programming knowledge, independent of any one codebase',
					},
				},
			},
		}),
		signal: AbortSignal.timeout(config.timeoutMs || 10_000),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ''}`);
	}

	const parsed = await response.json();
	if (!parsed?.answers) {
		throw new Error('response carried no answers');
	}
	return parsed.answers;
}

function unjudged(config, fallbackTier, note) {
	return {
		model: modelForTier(config, fallbackTier, fallbackTier),
		tier: fallbackTier,
		weight: null,
		confidence: null,
		needsProjectContext: null,
		judged: false,
		note,
	};
}

function modelForTier(config, tier, fallbackTier) {
	const models = config.models || {};
	return models[tier] || models[fallbackTier] || models.medium || models.small || models.large || '';
}

function nextTierUp(tier) {
	const at = TIER_ORDER.indexOf(tier);
	return at === -1 || at === TIER_ORDER.length - 1 ? tier : TIER_ORDER[at + 1];
}

function clamp(value, low, high) {
	return Math.min(high, Math.max(low, value));
}

export const _test = { WEIGHT_LEVELS, TIER_BY_LEVEL, CONFIDENCE_FLOOR, nextTierUp, clamp };
