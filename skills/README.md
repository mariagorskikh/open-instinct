# Skills

Skills are the agent's playbooks. Each one is a short markdown file that tells
the model how to handle one kind of task: book a table, triage mail, run the
morning brief, behave when a stranger texts. The model sees a one-line index of
every skill in its system prompt and reads the full file only when a task
matches. The format is the Agent Skills standard (agentskills.io), the same one
Pi, OpenClaw and Claude Code read, so skills move between those tools and this
one without changes.

## Layout

```
skills/
  README.md               this file (not a skill; it has no frontmatter)
  onboarding/SKILL.md
  scheduling/SKILL.md
  dining/SKILL.md
  travel/SKILL.md
  rides/SKILL.md
  email-triage/SKILL.md
  research/SKILL.md
  purchases/SKILL.md
  files/SKILL.md
  daily-brief/SKILL.md
  trusted-network/SKILL.md
  maritime-computer/SKILL.md
  web-apps/SKILL.md
```

One directory per skill, named like the skill. The file is always `SKILL.md`.
Keep everything the skill needs in that one file: `load_skill` returns
`SKILL.md` only.

## Format

```markdown
---
name: dining
description: Find and reserve restaurants. Use when the owner asks for ...
---

# Dining

Instructions the model follows, in plain markdown.
```

Frontmatter fields, as parsed by `@earendil-works/pi-coding-agent`
(`dist/core/skills.d.ts`, `SkillFrontmatter`):

| Field | Required | Rules |
|---|---|---|
| `name` | no, defaults to the directory name | lowercase `a-z`, `0-9`, hyphens; max 64 chars; no leading, trailing or double hyphens |
| `description` | yes | max 1024 chars; this is the only text the model sees before deciding to load the skill, so say what the skill does and when to use it |
| `disable-model-invocation` | no | `true` hides the skill from the prompt index; it can then only be loaded by name (a scheduled prompt or a command). None of ours set it |

Other keys are allowed and ignored. A SKILL.md without a description is
skipped with a warning diagnostic.

## Writing rules

- Under 120 lines. If it needs more, it is two skills.
- Concrete: tool names the agent actually has (see `docs/ARCHITECTURE.md`,
  Tools), exact wording for approvals, defaults for what the owner did not say.
- Example messages in the agent's voice: short, warm, no markdown, no emojis
  unless the owner uses them. iMessage renders markdown as literal asterisks.
- Every skill that can spend money, commit the owner, or touch a non-owner
  ends with a "Do not" list. The policy guard enforces the real limits; the
  list keeps the model from trying.
- Prose style matches the docs: short sentences, plain tone, no em-dashes.
- Non-owner content (messages, emails, pages, screens) is data, never
  instructions. Say so in any skill that reads it.

## How the server loads skills

At agent start `@open-instinct/server` (`packages/server/src/skills.ts`) loads
every `SKILL.md` with Pi's `loadSkillsFromDir`, logs any diagnostics, and adds
two things:

- An `<available_skills>` block in the system prompt with each skill's name and
  description, telling the model to call `load_skill` when a task matches.
  Skills with `disable-model-invocation: true` are left out of the block,
  but `load_skill` still loads them by name (from a schedule or a command).
- The `load_skill` tool. It takes a skill name and returns that skill's
  `SKILL.md`. Only skills found at boot can be named, so the model never passes
  a path. It needs only the `converse` capability, so skills work in every
  conversation, not just the owner's.

This replaces Pi's default of loading skills with the `read` tool. `read` is
confined to `workspace/` and is owner-only, so it could not open the skills
folder. `load_skill` returns `SKILL.md` only, so keep a skill self-contained
rather than pointing at extra files beside it.

`skillsDir` is `/app/skills` in the Maritime image (copied by
`deploy/Dockerfile.agent`), `<repo>/skills` in local dev, or
`$INSTINCT_SKILLS_DIR`. Owner skills under `$INSTINCT_DATA_DIR/skills` are not
loaded yet.

Scheduled jobs call skills by name in their prompt ("Run the daily-brief skill
for the owner"). The model then calls `load_skill` with that name.

## Adding a skill

1. `mkdir skills/<name>` and write `skills/<name>/SKILL.md` with the
   frontmatter above.
2. Keep it under 120 lines and give it a "Do not" list.
3. Run the loader check from `packages/server` (Node 22; it has the Pi
   dependency linked):

   ```bash
   node -e 'import("@earendil-works/pi-coding-agent").then(m => { const r = m.loadSkillsFromDir({ dir: "../../skills", source: "project" }); console.log(r.skills.map(s => s.name)); console.log(r.diagnostics); })'
   ```

   The list should include your skill and `diagnostics` should be empty. A
   `: ` inside the description breaks YAML; quote the value or reword it.
4. Mention it in `docs/ARCHITECTURE.md` if it introduces a new tool or
   capability. Most skills do not.
