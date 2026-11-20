// Native DeepSeek Harness (DSH) bundle for pstack.
//
// The bundle registers the shared skill tree through `ctx.skills.register`, so
// a DSH profile that loads pstack needs no skill symlinks, and it contributes
// pstack's session-start routing to root sessions. The bundle has no runtime
// dependencies beyond DSH itself: the plugin uses only Node built-ins and the
// services DSH already mounts.

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DSH_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(DSH_DIR);
const SKILLS_DIR = join(PLUGIN_ROOT, "skills");
const ROUTING_FILE = join(PLUGIN_ROOT, "hooks", "session-start-context.md");
const MAPPING_FILE = join(SKILLS_DIR, "poteto-mode", "references", "dsh-tools.md");

export const name = "pstack-dsh";
export const inject = ["skills", "systemPrompt", "agents"];

// pstack frontmatter is a small YAML subset: `key: value` lines whose values
// are unquoted strings, JSON-quoted strings, booleans, or JSON arrays. Keeping
// the parser here avoids a YAML dependency in the Pi package, which must stay
// dependency-free.
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    const [, key, raw] = field;
    let value = raw.trim();
    if (value.startsWith('"') || value.startsWith("[")) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.replace(/^"|"$/g, "");
      }
    } else if (value === "true" || value === "false") {
      value = value === "true";
    }
    data[key] = value;
  }
  return { data, body: text.slice(match[0].length) };
}

// Every directory bundle under skills/ that has a SKILL.md and the name and
// description DSH requires. Sorted for a stable catalog in tests and dumps.
export function loadBundledSkills(root = SKILLS_DIR) {
  const skills = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, "SKILL.md");
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const { data, body } = parseFrontmatter(text);
    if (typeof data.name !== "string" || typeof data.description !== "string") continue;
    skills.push({
      name: data.name,
      description: data.description,
      source: "bundled",
      ...(typeof data.whenToUse === "string" ? { whenToUse: data.whenToUse } : {}),
      content: body,
      path: file,
      resourceBase: { kind: "directory", path: dirname(file) },
      invocation: {
        modelInvocable: data["disable-model-invocation"] !== true,
        userInvocable: data["user-invocable"] !== false,
      },
      ...(Array.isArray(data.paths) ? { metadata: { paths: data.paths } } : {}),
    });
  }
  return skills;
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

export function readModelSheet(home = dshHome()) {
  try {
    return readFileSync(join(home, "pstack-models.md"), "utf8").trim();
  } catch {
    return "";
  }
}

// The sheet's `session hook: off` line turns the mandate off without removing
// the role lines, matching the other runtimes' sheet contract.
export function hookOff(sheet) {
  return /^\s*session hook:\s*off\s*$/im.test(sheet);
}

// The hook names the skills with their Claude Code plugin prefix. DSH loads
// them unqualified, so strip that prefix and point at the DSH mapping.
export function routingText() {
  const mandate = readFileSync(ROUTING_FILE, "utf8").trim().replaceAll("`pstack:", "`");
  const note =
    `pstack skills are written for Claude Code. When one names a Claude Code tool, a subagent role, ` +
    `or a Claude model, read ${MAPPING_FILE} before following it. DSH reads AGENTS.md as workspace ` +
    `context, so a standing instruction belongs there.`;
  return `${mandate}\n\n${note}`;
}

// dsh dropped `AgentRegistry.roots()` in 0.2.1-rc.3; the subagent service owns
// runtime tree membership now. Both forms answer the same question: is the
// initiator a top-level agent rather than a delegated child? An unmanaged or
// stale instance throws instead, and there the routing mandate stays on.
// Cordis throws on `ctx.subagents` here because this bundle never declared that
// dependency; `ctx.get()` is the service read that skips the inject requirement.
export function isRootInitiator(ctx, initiator) {
  if (typeof ctx.agents.roots === "function") {
    return ctx.agents.roots().some((root) => root.id === initiator.id);
  }
  const subagents = ctx.get("subagents");
  if (typeof subagents?.rootOf !== "function") return true;
  try {
    return subagents.rootOf(initiator) === initiator;
  } catch {
    return true;
  }
}

export function apply(ctx, config = {}) {
  for (const skill of loadBundledSkills(config.skillsDir ?? SKILLS_DIR)) {
    ctx.skills.register(skill);
  }

  if (config.routing === false) return;
  const routing = routingText();
  const order = typeof config.order === "number" ? config.order : 9000;
  ctx.systemPrompt.section({
    name: "pstack:routing",
    order,
    text: () => {
      if (hookOff(readModelSheet(config.home))) return "";
      const initiator = ctx.agents.currentInitiator();
      if (initiator && !isRootInitiator(ctx, initiator)) return "";
      return routing;
    },
  });
  ctx.systemPrompt.section({
    name: "pstack:models",
    order: order + 1,
    text: () => readModelSheet(config.home),
  });
}
