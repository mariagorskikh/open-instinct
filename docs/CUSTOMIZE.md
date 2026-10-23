# Customize your agent

Everything the model is told lives in plain files under the data directory
(`$INSTINCT_DATA_DIR`, default `./.instinct`; `/data` on Maritime). Edit a file and the
next message uses it. No rebuild, no restart, no prompt buried in code.

Analogy: the system prompt is a stack of index cards the agent reads before every reply.
Each card comes from one file. You can read the stack, and you can rewrite any card.

## Contents

1. [See what the agent is told](#1-see-what-the-agent-is-told)
2. [The five layers](#2-the-five-layers)
3. [Change the agent's name and voice](#3-change-the-agents-name-and-voice)
4. [Add standing instructions](#4-add-standing-instructions)
5. [Add a skill](#5-add-a-skill)
6. [Edit what it remembers](#6-edit-what-it-remembers)
7. [Change who may ask for what](#7-change-who-may-ask-for-what)
8. [Change the model](#8-change-the-model)
9. [On Maritime](#9-on-maritime)

## 1. See what the agent is told

```bash
instinct prompt            # the full system prompt your own thread gets right now
instinct prompt --layers   # one row per section: what it is, how long, which file decides it
instinct prompt --json     # the same sections as data
instinct prompt --channel email   # as the email thread would see it (imessage, sms, email, chat, scheduled)
```

`--layers` prints something like this:

```
  1  identity    1240 chars  <data>/PERSONA.md
  2  owner        180 chars  config.json owner
  3  principal    410 chars  contacts.json tier and policy.json capabilities
  4  channel      260 chars  built-in channel etiquette
  5  rules        820 chars  built-in safety rules
  6  memory       960 chars  <data>/memory/MEMORY.md and memory/journal/
  7  skills      2100 chars  skills/ index and tool guidance (computer, apps)
  8  long-tasks   300 chars  built-in
  9  now          140 chars  the clock and config.json owner.timezone
```

The built-in sections (channel etiquette, safety rules, long tasks, the clock) are in
`packages/core/src/prompt.ts`. They are short and they are the guard rails; change them
in code if you must, but the five layers below are where customizing belongs.

The preview is built from the data directory alone, with you as the owner. A running agent
adds the tool groups it actually wired (messaging, computer, apps) and the network guidance
for the person it is talking to; the text of each file is the same.

## 2. The five layers

| Layer | File | Change it with | What it does |
|---|---|---|---|
| Persona | `<data>/PERSONA.md` | `instinct persona edit` | who the agent is: voice, texting style, what it never does |
| Standing instructions | `<data>/AGENTS.md` | any editor | house rules that apply to every conversation |
| Skills | `skills/<name>/SKILL.md` (or `$INSTINCT_SKILLS_DIR`) | add a folder | playbooks for one kind of task, loaded when the task matches |
| Memory | `<data>/memory/MEMORY.md`, `memory/journal/` | any editor, or tell the agent | durable facts, preferences, what happened |
| Policy | `<data>/policy.json` | `instinct trust ...` | tiers, grants, spend limits: what each person may ask |

Order in the prompt: persona, standing instructions, owner card, who it is talking to,
channel etiquette, rules, memory, skills, pending approvals, long tasks, the time.

## 3. Change the agent's name and voice

The name is in `config.json` (`agent.name`). The voice is `PERSONA.md`.

```bash
# Name. Repeating init keeps everything else in config.json.
instinct init --name "Maria" --agent-name "Pip"

# Voice. Opens $VISUAL or $EDITOR; without one it prints the path to edit by hand.
instinct persona edit

# Or write it in one go.
instinct persona set "You are Pip. Dry wit, short sentences, never emojis. You confirm before you book anything."

# See it, or go back to the default.
instinct persona show
instinct persona reset
```

The first boot writes the default `PERSONA.md` (name, voice, texting style, a "never"
list; about thirty lines). It is yours after that: the agent never rewrites it. Setting
`INSTINCT_PERSONA` in the environment seeds the file on first boot only, which is how a
deployer gives a fresh agent a voice without touching its disk.

`config.json` also has `agent.persona`, a one-liner. When set, it is added under the
persona file as a note that wins where the two disagree. Use it for a quick tweak
("Persona: today, extra brief") and the file for the real thing.

Headings inside `PERSONA.md` are moved one level down when the prompt is built, so a
`# Voice` in your file does not look like a new section to the model.

## 4. Add standing instructions

Create `<data>/AGENTS.md`. Whatever it says is appended to the prompt right after the
persona, under "Standing instructions", in every conversation. Same convention Pi,
OpenClaw and Claude Code use for a project's `AGENTS.md`.

A deployer can seed it with `INSTINCT_INSTRUCTIONS` in the environment (an event brief,
house rules for every agent a gateway creates). Unlike `INSTINCT_PERSONA`, a changed value
is applied on the next boot as long as the file is still exactly what the last seed wrote;
once the owner edits `AGENTS.md`, it is theirs and the seed never touches it again.

```markdown
# House rules

- Confirm every restaurant booking by text before you book it.
- My partner is Sam. If Sam's agent asks for my free/busy, just answer.
- Weekday mornings I am at the gym until 8; do not schedule calls before 9.
```

Keep it short. Long standing instructions cost tokens on every message; anything task
specific belongs in a skill, and anything about a person belongs in memory or a grant.

## 5. Add a skill

A skill is one folder with one `SKILL.md`, in the Agent Skills format
(`skills/README.md` has the rules and the loader check).

```bash
mkdir skills/plants
cat > skills/plants/SKILL.md <<'EOF'
---
name: plants
description: Water and feed the owner's houseplants on schedule. Use when the owner asks about plants, watering or fertilizer.
---

# Plants

Keep a list of plants in memory under "## Plants" with the last watered date. ...
EOF
instinct prompt --layers    # the skills row grows; `instinct prompt | grep plants` shows the index line
```

The agent sees one line per skill (name and description) and reads the file only when a
task matches, so the description is what decides whether a skill is used.

The folder is `<repo>/skills` in development and `/app/skills` in the Docker image. To use
your own folder instead, set `INSTINCT_SKILLS_DIR=/path/to/skills` on the server. A second
folder, `<data>/skills`, is always read after it and re-read every 30 seconds: a skill the
owner (or the agent, when asked) puts there, as `<data>/skills/<name>/SKILL.md`, is in the
index within 30 seconds. Shipped skills win: an owner skill with the same name as one is
skipped (the log says so). Owner skills are private by default: only the owner sees them in
the index or can load them. To let contacts and strangers use one too, add
`visibility: public` to its frontmatter. Symlinks inside the folder are not followed, the
search goes three folders deep, and a SKILL.md over 64 KB is not loaded.

## 6. Edit what it remembers

`memory/MEMORY.md` is Markdown you can edit by hand. The top of it goes into every owner
prompt (about 2,400 characters), followed by the tail of today's and yesterday's journal.
Short lines, one fact per line.

```bash
$EDITOR .instinct/memory/MEMORY.md
instinct chat "remember that I like window seats"     # the agent appends it itself
```

A `## Preferences` heading matters: that section, and only that section, is what people in
the partner and family tiers may hear about ("most" for partner, "some" for family). Put
food, travel and scheduling preferences there and keep medical or financial notes above it.

## 7. Change who may ask for what

Seven tiers (owner, staff, partner, family, friend, contact, stranger) and a table of what each tier
may do, in [PERMISSIONS.md](PERMISSIONS.md). Three ways to change it:

```bash
# Move a person between tiers.
instinct trust set "Sam Lee" partner

# Give one person one more thing, for a while.
instinct trust grant sam-lee calendar.write,plans.commit --until 2026-10-12 --max-usd 150 --note "dinner this week"
instinct trust list
instinct trust revoke g_1a2b3c4d
```

To change what a whole tier gets, edit `policy.json`. `tiers` holds overrides of the
default table, `tier -> capability -> permission` (`yes`, `ask`, `no`, `limit`, `partial`,
`intro`). This lets every friend see your calendar titles and makes family purchases
something you approve instead of a no:

```json
{
  "version": 1,
  "tiers": {
    "friend": { "calendar.read": "yes" },
    "family": { "purchase": "ask" }
  },
  "grants": [],
  "spend": { "perActionUsd": 100, "perDayUsd": 300, "askAbove": 50, "neverWithoutAsk": ["flights", "hotels"], "allowedMerchants": [], "blockedMerchants": [] },
  "strangerLimits": { "conversationsPerDay": 3, "messagesPerConversation": 10 }
}
```

`spend` is the owner's own purchase policy: the agent asks above `askAbove` dollars, never
goes past `perActionUsd` or `perDayUsd`, and always asks for anything matching
`neverWithoutAsk`. The guard is code, not prompt: a tier change here is enforced before
any tool runs, whatever the persona says.

## 8. Change the model

```bash
# For this process. Env wins over config.json for the model (and, likewise, COMPOSIO_TOOLKITS for the toolkit list).
INSTINCT_MODEL=anthropic/claude-sonnet-5-5 instinct dev

# For good: writes config.json.
instinct init --name "Maria" --model anthropic/claude-sonnet-5-5

# Another provider: its key, its usual variable.
INSTINCT_MODEL=openai/gpt-5.4 OPENAI_API_KEY=sk-... instinct dev
INSTINCT_MODEL=google/gemini-3-pro GEMINI_API_KEY=... instinct dev

# Anything OpenAI-compatible (Ollama, vLLM, LiteLLM).
INSTINCT_MODEL=openai-compatible/llama-4 OPENAI_BASE_URL=http://localhost:11434/v1 instinct dev

# On Maritime, with no key of your own.
instinct deploy --image ghcr.io/<you>/open-instinct-agent:latest --maritime-llm --model gpt-5.4
```

The id is `provider/model` from Pi's catalog. `config.json` also has `model.fallback` and
`model.cheap` for the day the runtime uses them, and `model.thinking` (`off`, `minimal`,
`low`, `medium`, `high`). Which keys each provider reads: [KEYS.md](KEYS.md), section 9.

## 9. On Maritime

The data directory is `/data` inside the agent's microVM, and the same files apply. Ways in:

- Seed before the first boot: set `INSTINCT_PERSONA` (and `INSTINCT_AGENT_NAME`,
  `INSTINCT_MODEL`) as environment variables on the agent in the Maritime dashboard, or in
  the gateway's env for every agent it creates. `INSTINCT_INSTRUCTIONS` seeds `AGENTS.md`
  the same way and, unlike the persona, follows a changed value on redeploy until the
  owner edits the file.
- Edit later: open the agent in the Maritime dashboard and edit `/data/PERSONA.md`,
  `/data/AGENTS.md` or `/data/memory/MEMORY.md` from its shell. The next message uses them.
- Tiers and grants: the policy tools (`trust_set_tier`, `trust_grant`) work over text, so
  "Sam is my partner" or "Sam can book us dinner this week" does the same as the CLI.

Skills ship inside the image (`deploy/Dockerfile.agent` copies `skills/` to `/app/skills`).
A skill that should not wait for a new image goes under `/data/skills/<name>/SKILL.md`:
the agent can put it there itself when you ask ("install the haiku skill from this repo"),
and it is live within 30 seconds. It is yours alone unless its frontmatter says
`visibility: public` (see section 5).


Two more layers are always present: **reach** (everything happens in this chat: connect links, files and takeover links travel through the thread) and **setup** (what is set up right now, so the agent says exactly what is missing instead of guessing). Both are built in; `instinct prompt` shows them.
