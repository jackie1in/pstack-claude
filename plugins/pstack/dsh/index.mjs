// Native DeepSeek Harness (DSH) bundle for pstack.
//
// The bundle registers the shared skill tree through `ctx.skills.register`, so
// a DSH profile that loads pstack needs no skill symlinks, and it contributes
// pstack's session-start routing to root sessions. It also gives setup-pstack a
// way to see every model this deployment offers: DSH exposes model discovery
// only through `list_subagent_models`, which answers with the Session's
// authorized subagent routes and collapses to the parent's single model when the
// Host records no model-selection policy. So the bundle registers its own
// read-only catalog tool, and it records the catalog routes as the Session
// policy when the Host does not own that decision. The bundle has no runtime
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
// `agents` supplies tree membership for the routing gate, `skills` and
// `systemPrompt` carry the catalog and the sheet, and `tools`/`llm` back the
// model catalog. Injecting all five lets cordis hold the plugin until each is
// mounted, instead of racing the model tool's registration against load order.
export const inject = ["skills", "systemPrompt", "agents", "tools", "llm"];

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

// DSH's `list_subagent_models` answers from the Session's model-selection
// policy, so a deployment that never recorded one shows only the parent's
// route. The catalog below asks the LLM service instead, which is the same
// source the Host's own model settings read.
const POLICY_EVENT = "subagent/model-selection-policy";
const CATALOG_TOOL = "list_dsh_models";

function modelLine(provider, model) {
  const description = model.description === undefined ? "" : `: ${model.description}`;
  return `${provider}/${model.id} — ${model.name}${description}`;
}

// Model-facing catalog listing. The three shapes mirror DSH's own discovery
// tool so a model that learned one can read the other: no arguments lists
// providers, `provider` lists its advertised models, and `provider` + `model`
// lists that model's reasoning efforts.
export async function catalogText(llm, request = {}, signal) {
  const { provider, model } = request;
  if (model !== undefined && provider === undefined) throw new Error("`model` requires `provider`");
  if (provider === "") throw new Error("`provider` must be non-empty");
  if (model === "") throw new Error("`model` must be non-empty");
  const providers = llm.listProviders();
  if (provider === undefined) {
    return providers.length === 0
      ? "(no LLM providers)"
      : providers.map((entry) => `${entry.id} — ${entry.name}`).join("\n");
  }
  if (!providers.some((entry) => entry.id === provider)) {
    const known = providers.map((entry) => entry.id).join(", ") || "(none)";
    throw new Error(`LLM provider "${provider}" is not registered; available providers: ${known}`);
  }
  if (model === undefined) {
    const models = await llm.listModels(provider);
    signal?.throwIfAborted();
    return models.length === 0
      ? `(no advertised models for ${provider})`
      : models.map((entry) => modelLine(provider, entry)).join("\n");
  }
  const info = await llm.resolveModelInfo(provider, model, signal);
  const efforts =
    info.reasoning?.efforts
      .map((effort) => {
        const marker = info.reasoning?.defaultEffort === effort.id ? " (default)" : "";
        const description = effort.description === undefined ? "" : `: ${effort.description}`;
        return `${effort.id}${marker} — ${effort.name}${description}`;
      })
      .join("\n") || "(no advertised reasoning efforts)";
  return `${modelLine(provider, info)}\nReasoning efforts:\n${efforts}`;
}

function modelCatalogTool(llm) {
  return {
    name: CATALOG_TOOL,
    description:
      "Inspect this DeepSeek Harness deployment's model catalog. No arguments: registered providers. " +
      "`provider`: that provider's advertised models. `provider` + `model`: that model's reasoning efforts. " +
      "Use it to choose pstack role models. `list_subagent_models` names the narrower subset this Session " +
      "authorizes for child selection; when it lists routes, prefer those over the wider catalog. " +
      "Omit optional fields rather than sending empty strings.",
    parameters: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Registered LLM provider id." },
        model: { type: "string", description: "Exact model id; requires provider." },
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, result) => [{ type: "text", text: result }],
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => catalogText(llm, args, exec.signal),
  };
}

// Every route the deployment advertises, as the `{ provider, model }` pairs a
// model-selection policy records. A provider whose catalog fails to load is
// skipped rather than emptying the list for the providers that answered.
export async function catalogRoutes(llm) {
  const routes = [];
  const seen = new Set();
  for (const provider of llm.listProviders()) {
    let models;
    try {
      models = await llm.listModels(provider.id);
    } catch {
      continue;
    }
    for (const model of models) {
      const key = `${provider.id}\u0000${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ provider: provider.id, model: model.id });
    }
  }
  return routes;
}

// The Host owns the decision once `/model-selection-settings` is enabled: its
// listener records the user's exact allowlist in each fresh Session. Reading it
// through `ctx.get()` keeps this bundle independent of a service that a
// skills-only or minimal profile may never mount.
export function hostOwnsModelSelection(ctx) {
  const settings = ctx.get("subagentModelSelection");
  if (settings === undefined) return false;
  try {
    return settings.current().enabled === true;
  } catch {
    // Enabled with an empty allowlist throws. Let the Host fail loudly instead
    // of recording a catalog policy behind its back.
    return true;
  }
}

// A resumed or forked Session already carries whatever policy it recorded, and
// the Host appends its own only to a fresh log, so the same gate applies here.
// The append must never take down agent creation, which is why the caller wraps
// it: a session is still usable with the parent route alone.
export function recordCatalogPolicy(session, routes) {
  if (session === undefined || session.firstLiveSeq !== 0 || routes.length === 0) return false;
  session.append(POLICY_EVENT, { allowedModels: routes.map((route) => ({ ...route })) });
  return true;
}

export function apply(ctx, config = {}) {
  for (const skill of loadBundledSkills(config.skillsDir ?? SKILLS_DIR)) {
    ctx.skills.register(skill);
  }

  // Cordis resolves both inject dependencies before this runs. The guards keep
  // a direct `apply()` call, as the tests make, safe when they are absent.
  const llm = ctx.get("llm");
  const tools = ctx.get("tools");
  if (llm !== undefined && typeof tools?.register === "function") {
    tools.register(modelCatalogTool(llm));
  }
  if (llm !== undefined && typeof ctx.on === "function") {
    // A provider's catalog is in-memory, so each creation reads the current
    // one instead of trusting a snapshot from process start. `agent/created`
    // is serial and awaited, so a throw here would abort the Agent the Host is
    // publishing; every path stays inside the guard, and a Session without the
    // policy simply keeps its parent route.
    ctx.on("agent/created", async ({ agent }) => {
      try {
        if (hostOwnsModelSelection(ctx)) return;
        recordCatalogPolicy(agent.session, await catalogRoutes(llm).catch(() => []));
      } catch {
        // keep the Session usable with the parent route alone
      }
    });
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
