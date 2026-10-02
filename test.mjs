/**
 * Offline unit tests for taste-router: deterministic, no live model, no auth.
 * Run: node --experimental-strip-types test.mjs   (from this directory)
 *
 * Covers the offline-checkable Verification Notes in
 * .rpiv/artifacts/designs/2026-09-30_08-07-44_taste-skill-auto-routing.md:
 * no-match free path, boost gating, broken-config warn-once, threshold
 * reachability, corrupt-rule degradation, name->path resolution, hook chaining,
 * and config tuning with no code edit.
 *
 * Three things are deliberately NOT asserted, because no offline assertion can
 * distinguish them:
 *   - the package.json read gating (the read is wrapped in try/catch and has no
 *     observable effect — see t6);
 *   - the hook's no-match early return (buildDirective independently returns
 *     undefined when no matched row survives — see t13);
 *   - the substring-match false-positive ceiling (mitigated by weight 1 on every
 *     collision-prone token — see the artifact's Verification Notes).
 *
 * index.ts imports the pi package as a TYPE only, so this file resolves nothing
 * from @earendil-works/* — a MODULE_NOT_FOUND here means a runtime import
 * leaked into index.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import tasteRouter, { CONFIG_URL, FRONTEND_DEP_BONUS, buildDirective, classify, loadConfig } from "./index.ts";

const assert = (cond, msg) => {
	if (!cond) {
		console.error("FAIL:", msg);
		process.exitCode = 1;
	} else console.log("PASS:", msg);
};

// tmpRoot has NO package.json, so it is the deterministic "no repo signal" cwd.
const tmpRoot = mkdtempSync(join(tmpdir(), "taste-router-"));
// Cleanup AND summary live in the exit handler, not as trailing statements: a
// throwing assertion must not leak the temp dir or swallow the summary line.
process.on("exit", () => {
	rmSync(tmpRoot, { recursive: true, force: true });
	console.log(process.exitCode ? "test.mjs: FAILURES" : "test.mjs: all green");
});
const frontendDir = join(tmpRoot, "frontend");
mkdirSync(frontendDir, { recursive: true });
writeFileSync(join(frontendDir, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" } }));

/**
 * Point CONFIG_URL at a fixture, run fn, restore. CONFIG_URL is a mutable URL
 * object and loadConfig() reads it per call, so no restart is needed.
 */
const realHref = CONFIG_URL.href;
function withConfig(text, fn) {
	const file = join(tmpRoot, "config-under-test.json");
	writeFileSync(file, text);
	CONFIG_URL.href = pathToFileURL(file).href;
	try {
		return fn();
	} finally {
		CONFIG_URL.href = realHref;
	}
}

function captureWarn(fn) {
	const seen = [];
	const orig = console.warn;
	console.warn = (s) => seen.push(String(s));
	try {
		fn();
	} finally {
		console.warn = orig;
	}
	return seen;
}

// --- 1. missing config file: silent, defaults. Runs FIRST because configWarned
//        is a module-level latch — a warn here would make t2 vacuous.
CONFIG_URL.href = pathToFileURL(join(tmpRoot, "does-not-exist.json")).href;
const missingWarns = captureWarn(() => loadConfig());
CONFIG_URL.href = realHref;
assert(missingWarns.length === 0, "t1: missing config.json warns nothing");
assert(Object.keys(loadConfig().skills).length > 0, "t1: real config.json loads skill rules");

// --- 2. malformed config: defaults + warns ONCE across two calls (the latch).
const malformedWarns = captureWarn(() => {
	const first = withConfig("{ not json", () => loadConfig());
	const second = withConfig("{ not json", () => loadConfig());
	assert(first.threshold === 3 && Object.keys(first.skills).length === 0, "t2: malformed config falls back to defaults");
	assert(Object.keys(second.skills).length === 0, "t2: second call still falls back");
});
assert(malformedWarns.length === 1, "t2: malformed config warns once per process, not once per prompt");

// --- 3. structurally corrupt rules are dropped before the classifier sees them.
const corrupt = withConfig(
	JSON.stringify({
		threshold: 3,
		skills: {
			good: { label: "ok", keywords: { alpha: 3 } },
			"null-keywords": { label: "bad", keywords: null },
			"numeric-label": { label: 7, keywords: { beta: 3 } },
			"negative-weight": { label: "bad", keywords: { gamma: -1 } },
			"empty-keywords": { label: "bad", keywords: {} },
		},
	}),
	() => loadConfig(),
);
assert(Object.keys(corrupt.skills).join(",") === "good", "t3: only the well-formed rule survives loadConfig()");
assert(classify("beta gamma alpha", tmpRoot, corrupt).length === 1, "t3: dropped rules never reach the classifier");

// --- 4. real config: the FRD example prompt reaches threshold on the right skill.
const config = loadConfig();
const hit = classify("build a landing page for a coffee shop", tmpRoot, config);
assert(hit.length >= 1 && hit[0].skill === "design-taste-frontend", "t4: FRD example prompt crosses threshold, tops design-taste-frontend");

// --- 5. no-match is the free path.
assert(classify("fix the failing pytest", tmpRoot, config).length === 0, "t5: non-frontend prompt scores nothing");

// --- 6. a frontend repo cannot manufacture a match from zero keyword hits.
//        NOTE: the gating itself (package.json read only after a keyword hit) is
//        NOT observable through classify() — the read is wrapped in try/catch and
//        has no side effect — so no assertion here can detect an ungated build.
//        What IS observable, and what the second assertion guards, is the numeric
//        condition that makes gating behaviourally irrelevant: the bonus alone
//        must stay under the threshold. Recorded as a ceiling in Verification Notes.
assert(classify("fix the failing pytest", frontendDir, config).length === 0, "t6: frontend package.json with zero keyword hits never matches");
assert(FRONTEND_DEP_BONUS < config.threshold, "t6: the boost alone can never cross the threshold (" + FRONTEND_DEP_BONUS + " < " + config.threshold + ")");

// --- 7. boost application: the same weak prompt routes only inside a frontend repo.
const weak = "make the ui minimal and clean";
const boosted = classify(weak, frontendDir, config);
const unboosted = classify(weak, tmpRoot, config);
assert(boosted.some((m) => m.skill === "minimalist-ui") && unboosted.length === 0, "t7: gated boost routes the weak prompt inside a frontend repo only");

// --- 8. maxMatches caps a degenerate directive.
const many = classify("redesign my minimalist brutalist landing page with gsap scrolltrigger", tmpRoot, config);
assert(many.length === config.maxMatches, "t8: matches are capped at maxMatches");

// --- 9. the developer's >= 20 keywords per skill holds for the shipped table.
const thin = Object.entries(config.skills)
	.filter(([, rule]) => Object.keys(rule.keywords).length < 20)
	.map(([name]) => name);
assert(thin.length === 0, "t9: every skill rule has >= 20 weighted keywords" + (thin.length ? " (thin: " + thin.join(", ") + ")" : ""));

// --- 10. directive shape: tag, one row per loaded skill, [MATCH], absolute path.
const loaded = Object.keys(config.skills).map((name) => ({ name, filePath: "/abs/" + name + "/SKILL.md" }));
const directive = buildDirective(config, hit, loaded);
assert(typeof directive === "string", "t10: a matched prompt yields a directive");
const rows = (directive ?? "").split("\n").filter((l) => l.startsWith("- "));
assert(directive?.startsWith("<!-- taste-router -->"), "t10: directive carries the tag");
assert(rows.length === Object.keys(config.skills).length, "t10: one row per configured skill that resolves to a loaded SKILL.md");
assert(directive?.includes("design-taste-frontend  [MATCH]"), "t10: matched row is marked [MATCH]");
assert(directive?.includes("/abs/design-taste-frontend/SKILL.md"), "t10: matched row carries the absolute SKILL.md path");

// --- 11. the drop warning uses its own latch (skillWarned) and names every dropped skill.
//         Runs before t12: skillWarned latches on the first drop, so a later
//         warn-once assertion would be vacuous.
const dropWarns = captureWarn(() => {
	buildDirective(config, many, []);
	buildDirective(config, many, []);
});
assert(
	dropWarns.length === 1 && dropWarns[0].includes("design-taste-frontend") && dropWarns[0].includes("minimalist-ui"),
	"t11: drop warning fires once and names every dropped skill",
);

// --- 12. name->path: a matched skill that is not loaded is dropped, never emitted with an undefined path.
assert(buildDirective(config, hit, [{ name: "gpt-taste", filePath: "/abs/gpt-taste/SKILL.md" }]) === undefined, "t12: matched-but-unloaded skill drops the whole block");

// --- 13. hook: appends to event.systemPrompt (chaining), no-ops on no match.
//         systemPrompt is getter-only and .mjs is always strict mode, so a hook
//         that WRITES event.systemPrompt throws instead of silently passing.
//         The prior-handler marker is distinctive, so a hook that rebuilds the
//         prompt from a cached base instead of reading event.systemPrompt fails.
//         NOTE: hookMiss cannot detect removal of the hook's own no-match early
//         return — buildDirective independently returns undefined when no matched
//         row survives. Recorded as a ceiling in Verification Notes.
let handler;
tasteRouter({ on: (event, fn) => { if (event === "before_agent_start") handler = fn; } });
const PRIOR = "PRIOR_HANDLER_SYSTEM_PROMPT";
const makeEvent = (prompt) => {
	const ev = { prompt, systemPromptOptions: { cwd: tmpRoot, skills: loaded } };
	Object.defineProperty(ev, "systemPrompt", { get: () => PRIOR, enumerable: true });
	return ev;
};
/** A throwing hook is a clean FAIL here, not a crash that skips the summary. */
const callHook = (prompt) => {
	try {
		return handler(makeEvent(prompt));
	} catch (err) {
		return err;
	}
};
const hookHit = callHook("build a landing page for a coffee shop");
const hookMiss = callHook("fix the failing pytest");
assert(
	typeof hookHit?.systemPrompt === "string" && hookHit.systemPrompt.startsWith(PRIOR + "\n\n<!-- taste-router -->"),
	"t13: hook appends the directive onto event.systemPrompt (a hook that writes it or caches a base fails)",
);
assert(hookMiss === undefined, "t13: hook returns undefined on no match");

// --- 14. offline-testability invariant: index.ts imports the pi package as a type only.
const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const piLines = src.split("\n").filter((l) => l.includes("@earendil-works"));
assert(piLines.length === 1 && piLines[0].trimStart().startsWith("import type"), "t14: index.ts imports the pi package only as a type");

// --- 15. tuning config.json changes behavior with no code edit (Requirement,
//         Verification Note 707). Both directions: a raised threshold disables
//         routing, and a new phrase routes a skill that never matched before.
const raised = withConfig(
	JSON.stringify({ threshold: 99, maxMatches: 3, frontendDeps: [], skills: { "design-taste-frontend": { label: "x", keywords: { "landing page": 3 } } } }),
	() => loadConfig(),
);
assert(classify("build a landing page for a coffee shop", tmpRoot, raised).length === 0, "t15: raising threshold in config.json disables routing with no code edit");
const retuned = withConfig(
	JSON.stringify({ threshold: 3, maxMatches: 3, frontendDeps: [], skills: { brandkit: { label: "x", keywords: { "coffee shop": 3 } } } }),
	() => loadConfig(),
);
assert(classify("build a landing page for a coffee shop", tmpRoot, retuned)[0]?.skill === "brandkit", "t15: adding a phrase in config.json routes a new skill with no code edit");
