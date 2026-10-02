/**
 * taste-router — detect frontend/UI intent in the user prompt and inject a
 * tagged skill-routing directive so the model reads the right taste-family
 * SKILL.md by itself.
 *
 * Patterns: extensions/simple-english/index.ts:454-467 (before_agent_start
 * append + undefined no-op), extensions/headroom/index.ts:95-108 (ENOENT
 * discrimination in the config loader).
 *
 * Type-only imports from the pi package keep this file offline-testable with
 * `node --experimental-strip-types test.mjs` (no dependency resolution).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------- types

export interface SkillRule {
	/** Human label shown in the injected routing table. */
	label: string;
	/** Keyword/phrase -> weight. A skill's score is the sum of matched weights. */
	keywords: Record<string, number>;
}

export interface TasteRouterConfig {
	/** Minimum score for a skill to be marked as a match. */
	threshold: number;
	/** Maximum number of skills marked [MATCH] in one directive. */
	maxMatches: number;
	/** package.json dependency names that signal a frontend project. */
	frontendDeps: string[];
	/** Skill name -> routing rule. Names resolve to SKILL.md paths at fire time. */
	skills: Record<string, SkillRule>;
}

export const DEFAULT_CONFIG: TasteRouterConfig = {
	threshold: 3,
	maxMatches: 3,
	frontendDeps: [],
	skills: {},
};

// ---------------------------------------------------------------- config

export const CONFIG_URL = new URL("config.json", import.meta.url);

/** Warn at most once per process — the hook calls loadConfig() on every prompt. */
let configWarned = false;

function warnOnce(message: string): void {
	if (configWarned) return;
	configWarned = true;
	console.warn(message);
}

/** Keep only well-formed rules; a corrupt rule must never reach the classifier. */
function sanitizeSkills(raw: unknown): Record<string, SkillRule> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, SkillRule> = {};
	for (const [name, rule] of Object.entries(raw as Record<string, unknown>)) {
		if (!rule || typeof rule !== "object" || Array.isArray(rule)) continue;
		const { label, keywords } = rule as { label?: unknown; keywords?: unknown };
		if (
			typeof label !== "string" ||
			!keywords ||
			typeof keywords !== "object" ||
			Array.isArray(keywords)
		) {
			continue;
		}
		const clean: Record<string, number> = {};
		for (const [phrase, weight] of Object.entries(
			keywords as Record<string, unknown>,
		)) {
			if (
				typeof weight === "number" &&
				Number.isFinite(weight) &&
				weight > 0 &&
				phrase.trim()
			) {
				clean[phrase.toLowerCase()] = weight;
			}
		}
		if (Object.keys(clean).length > 0) out[name] = { label, keywords: clean };
	}
	return out;
}

export function loadConfig(): TasteRouterConfig {
	try {
		const parsed = JSON.parse(
			readFileSync(CONFIG_URL, "utf-8"),
		) as Partial<TasteRouterConfig>;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("not a JSON object");
		}
		const skills = sanitizeSkills(parsed.skills);
		if (
			Object.keys(parsed.skills ?? {}).length > 0 &&
			Object.keys(skills).length === 0
		) {
			warnOnce(
				"[taste-router] config.json has no usable skill rules; routing disabled",
			);
		}
		return {
			threshold:
				typeof parsed.threshold === "number"
					? parsed.threshold
					: DEFAULT_CONFIG.threshold,
			maxMatches:
				typeof parsed.maxMatches === "number"
					? parsed.maxMatches
					: DEFAULT_CONFIG.maxMatches,
			frontendDeps: Array.isArray(parsed.frontendDeps)
				? parsed.frontendDeps.filter((d): d is string => typeof d === "string")
				: DEFAULT_CONFIG.frontendDeps,
			skills,
		};
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		const reason = err instanceof Error ? err.message : String(err);
		if (code !== "ENOENT") {
			warnOnce(
				`[taste-router] ignoring broken config.json (${reason}); routing disabled`,
			);
		}
		return { ...DEFAULT_CONFIG };
	}
}

// ---------------------------------------------------------------- classifier

/**
 * Bonus added to every skill with at least one keyword hit when the working
 * directory's package.json declares a frontendDeps entry. Gated: zero keyword
 * hits means zero boost, so a repo signal alone can never create a match.
 */
export const FRONTEND_DEP_BONUS = 2;

export interface MatchResult {
	/** Skill name from the config table (resolves to a SKILL.md path later). */
	skill: string;
	/** Sum of matched keyword weights, plus FRONTEND_DEP_BONUS when it applies. */
	score: number;
}

/** True when the parsed package.json declares any of `deps` in its dependency sections. */
function hasFrontendDep(pkg: unknown, deps: string[]): boolean {
	if (!pkg || typeof pkg !== "object") return false;
	for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
		const map = (pkg as Record<string, unknown>)[section];
		if (!map || typeof map !== "object") continue;
		const names = new Set(Object.keys(map as Record<string, unknown>));
		if (deps.some((d) => names.has(d))) return true;
	}
	return false;
}

/**
 * Score the prompt against every skill rule and return the matches.
 *
 * A skill's score is the sum of the weights of every keyword phrase found in
 * the lowercased prompt (substring match — see the artifact's Verification
 * Notes for the known ceiling). Skills with a positive score get
 * FRONTEND_DEP_BONUS when `<cwd>/package.json` declares a frontend
 * dependency; the boost is gated on at least one keyword hit so it can never
 * create a match from nothing.
 *
 * Returns matches ordered by score descending (ties keep config order),
 * capped at config.maxMatches. Empty array when nothing crosses threshold.
 */
export function classify(
	prompt: string,
	cwd: string,
	config: TasteRouterConfig,
): MatchResult[] {
	const lower = prompt.toLowerCase();
	const scored: Array<{ skill: string; score: number }> = [];
	for (const [skill, rule] of Object.entries(config.skills)) {
		let score = 0;
		for (const [phrase, weight] of Object.entries(rule.keywords)) {
			if (lower.includes(phrase)) score += weight;
		}
		if (score > 0) scored.push({ skill, score });
	}
	if (scored.length === 0) return [];

	// Gated repo signal: only prompts with >=1 keyword hit pay the read.
	try {
		const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
		if (hasFrontendDep(pkg, config.frontendDeps)) {
			for (const entry of scored) entry.score += FRONTEND_DEP_BONUS;
		}
	} catch {
		// No/unreadable package.json — no boost; the normal case for non-JS
		// repos and must never surface as an error.
	}

	const matches = scored.filter((entry) => entry.score >= config.threshold);
	// Stable sort (ES2019+): score desc, ties keep config insertion order.
	matches.sort((a, b) => b.score - a.score);
	return matches.slice(0, config.maxMatches);
}

// ---------------------------------------------------------------- directive

/** Minimal shape of a loaded skill needed for name -> path resolution. */
export interface LoadedSkill {
	name: string;
	filePath: string;
}

/**
 * Separate latch from `configWarned`: a broken-config warning must not silence
 * the skill-resolution warning for the rest of the process.
 */
let skillWarned = false;

function warnOnceSkill(message: string): void {
	if (skillWarned) return;
	skillWarned = true;
	console.warn(message);
}

/**
 * Build the routing directive block, or undefined when nothing should be
 * injected.
 *
 * Every configured skill that resolves to a loaded SKILL.md gets a row;
 * matched rows are marked [MATCH] and carry their absolute SKILL.md path. A
 * matched skill that is not loaded in this session is dropped with a
 * warn-once — pointing the model at a SKILL.md pi cannot load is worse than
 * not routing it. When no matched row survives, the block is not injected at
 * all.
 */
export function buildDirective(
	config: TasteRouterConfig,
	matches: MatchResult[],
	skills: LoadedSkill[],
): string | undefined {
	const paths = new Map<string, string>();
	for (const skill of skills) paths.set(skill.name, skill.filePath);

	const matched = new Set(matches.map((m) => m.skill));
	const lines: string[] = [];
	const dropped: string[] = [];
	let emittedMatch = false;

	for (const [name, rule] of Object.entries(config.skills)) {
		const filePath = paths.get(name);
		if (!filePath) {
			if (matched.has(name)) dropped.push(name);
			continue;
		}
		const isMatch = matched.has(name);
		lines.push(`- ${rule.label} -> ${name}${isMatch ? "  [MATCH]" : ""}`);
		if (isMatch) {
			lines.push(`  ${filePath}`);
			emittedMatch = true;
		}
	}

	if (dropped.length > 0) {
		warnOnceSkill(
			`[taste-router] matched skill(s) not loaded; dropped: ${dropped.join(", ")}`,
		);
	}

	if (!emittedMatch) return undefined;

	return [
		"<!-- taste-router -->",
		"Frontend/UI task detected. Before answering, read the matching skill's SKILL.md with the read tool:",
		...lines,
	].join("\n");
}

// ---------------------------------------------------------------- extension

export default function tasteRouter(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		const config = loadConfig();
		const matches = classify(event.prompt, event.systemPromptOptions.cwd, config);
		if (matches.length === 0) return;
		const directive = buildDirective(
			config,
			matches,
			event.systemPromptOptions.skills ?? [],
		);
		if (!directive) return;
		return { systemPrompt: event.systemPrompt + "\n\n" + directive };
	});
}