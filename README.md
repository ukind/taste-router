# taste-router — Pi Extension

taste-router reads each user prompt before the agent starts. On a frontend or UI task,
it adds a routing table to the system prompt. The table lists the ten taste-family
skills and gives the absolute `SKILL.md` path for the matched skill. The model then
reads that file with the `read` tool.

If no skill matches, the extension adds nothing. That no-match path costs almost
nothing: one pass of substring tests over the keyword table.

## Install

1. Copy the `taste-router` folder into `~/.pi/agent/extensions/`.
2. Start pi. Pi discovers `extensions/*/index.ts` on its own. You do not need to edit
   any settings file.

## How it works

For each prompt, the extension does this:

1. It makes the prompt lower case.
2. For each skill, it adds the weight of every keyword that appears in the prompt.
3. If the current folder has a frontend dependency, it adds 2 to each skill with at
   least one keyword hit.
4. It keeps the skills with a score of 3 or more.
5. It sorts the result by score, high first, and keeps the top 3.
6. It builds the directive only for skills that pi loaded.

The score is the sum of the weights, not the number of hits. One strong keyword can
cross the threshold. Several weak keywords can cross it together. An unweighted
hit-count table cannot do this, so the weights are load-bearing.

## What you get

You do not run a command. The extension works on every prompt.

A frontend prompt adds this block to the end of the system prompt:

```text
<!-- taste-router -->
Frontend/UI task detected. Before answering, read the matching skill's SKILL.md with the read tool:
- new page / portfolio / redesign -> design-taste-frontend  [MATCH]
  C:\Users\utama\.pi\agent\skills\design-taste-frontend\SKILL.md
- GSAP / motion-heavy site -> gpt-taste
- design image provided -> image-to-code
- existing codebase UI upgrade -> redesign-existing-projects
- section-image generation (web) -> imagegen-frontend-web
- mobile app screens -> imagegen-frontend-mobile
- brand identity / logo system -> brandkit
- minimalist aesthetic -> minimalist-ui
- brutalist / industrial -> industrial-brutalist-ui
- Google Stitch DESIGN.md -> stitch-design-taste
```

Each configured skill gets one row. Only the matched row carries the `[MATCH]` marker
and the path.

A non-frontend prompt adds nothing:

```text
User: fix the failing pytest
(no <!-- taste-router --> block)
```

## Config file

`config.json` is the routing table. Tune it there. You do not need to change code or
restart pi, because the extension reads the file on every prompt.

| Key | Meaning | Shipped value |
| --- | --- | --- |
| `threshold` | Minimum score for a match | `3` |
| `maxMatches` | Maximum skills in one directive | `3` |
| `frontendDeps` | `package.json` names that mark a frontend repo | 27 names |
| `skills` | One entry per skill: a `label` and a `keywords` weight map | 10 skills |

Each skill entry looks like this:

```json
"design-taste-frontend": {
  "label": "new page / portfolio / redesign",
  "keywords": {
    "landing page": 3,
    "portfolio site": 3,
    "marketing site": 3,
    "hero": 1
  }
}
```

Use weight 3 for a phrase that only appears in a design request. Use weight 1 for a
short word that can appear inside another word.

### Common edits

- **Routing fires too often:** raise `threshold` to `4` or `5`.
- **Routing never fires:** lower `threshold`, or add your own phrasing to a skill.
- **A new skill to route:** add an entry to `skills` with at least 20 weighted
  keywords. The name must match a folder under `skills/`.
- **A skill must not route:** delete its entry from `skills`.

The extension keeps only well-formed rules. A rule with a null `keywords` map, a
non-string `label`, or a negative weight. This happens at load time.

## Frontend dependency boost

Some requests are too weak to match on words alone. "make the ui minimal and clean"
scores below the threshold. Inside a repo that lists a `frontendDeps` name in
`dependencies`, `devDependencies`, or `peerDependencies`, the same prompt routes.

The boost is gated: it applies only after at least one keyword hits. The boost value
(2) is below the threshold (3), so a frontend repo alone can never cause a match.

## Test

From this folder, run:

```bash
node --experimental-strip-types test.mjs
```

All 26 assertions pass. The suite prints `test.mjs: all green` and exits 0. It
needs no model, no network, and no login. `index.ts` imports the pi package as a type
only, so a `MODULE_NOT_FOUND` error for `@earendil-works/*` means a runtime import
leaked into `index.ts`.

## Troubleshooting

| Message | Cause | Fix |
| --- | --- | --- |
| `[taste-router] ignoring broken config.json (…); routing disabled` | `config.json` is not valid JSON | Correct the JSON. The next prompt uses the file again. |
| `[taste-router] config.json has no usable skill rules; routing disabled` | The `skills` block is empty or every rule is malformed | Add at least one well-formed skill entry. |
| `[taste-router] matched skill(s) not loaded; dropped: …` | A configured name has no loaded `SKILL.md` | Check the name against a folder under `skills/`. |

Each warning prints once per process, not once per prompt.

Two known limits:

- The keyword test is a substring test, so a keyword can match inside an unrelated
  word. Weight 1 on collision-prone keywords limits this.
- Inside a frontend repo, one weight-1 keyword plus the boost reaches the threshold
  (1 + 2 = 3). A non-design prompt can therefore route there. This is an accepted
  trade-off for v1.

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | The extension: config loader, classifier, directive builder, hook |
| `config.json` | The routing table: threshold, boost names, skill keyword weights |
| `test.mjs` | 26 offline assertions, no model required |

## License

MIT
