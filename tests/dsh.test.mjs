import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadModels } from "../tools/generate.mjs";
import { dshModelNamesSection, roleSkills, RUNTIMES, validateDshPackage } from "../tools/runtimes.mjs";
import {
  apply,
  catalogRoutes,
  catalogText,
  hookOff,
  loadBundledSkills,
  parseFrontmatter,
  readModelSheet,
  routingText,
} from "../plugins/pstack/dsh/index.mjs";
import { mappingCoverage } from "./mapping-coverage.mjs";

const runtime = RUNTIMES.find((row) => row.name === "DeepSeek Harness");
const repoRoot = join(import.meta.dir, "..");

mappingCoverage(runtime, [
  ["Read", "`read`"],
  ["Write", "`write`"],
  ["Edit", "`edit`"],
  ["Bash", "`bash`"],
  ["Glob", "`glob`"],
  ["Grep", "`grep`"],
  ["WebFetch", "`web_fetch`"],
  ["WebSearch", "WebSearch"],
  ["Skill", "`skill`"],
  ["AskUserQuestion", "`ask_user_question`"],
  ["Agent", "`subagent`"],
  ["SendMessage", "`send_message`"],
  ["TaskCreate", "`todo_write`"],
  ["TaskUpdate", "`todo_write`"],
  ["TodoWrite", "`todo_write`"],
  ["ScheduleWakeup", "ScheduleWakeup"],
  ["subagent_type", "`subagent_type`"],
  ["readonly", "`readonly`"],
  ["isolation", "`isolation`"],
  ["run_in_background", "`run_in_background`"],
]);

// dsh 0.2.2-rc.5 dropped `AgentRegistry.roots()`; tree membership moved to the
// subagent service, so the default fake matches that runtime and the legacy
// registry shape is opt-in. Cordis throws when a plugin reads a service it did
// not inject, so the fake throws on `ctx.subagents` exactly like the runtime and
// answers service reads through `ctx.get()`.
function fakeContext({ root = { id: "root" }, initiator = root, home, registry = {}, rootOf, llm, settings } = {}) {
  const skills = [];
  const sections = [];
  const tools = [];
  const listeners = new Map();
  const subagents = { rootOf: rootOf ?? ((agent) => (agent === root ? agent : root)) };
  return {
    skills,
    sections,
    tools,
    listeners,
    ctx: {
      skills: { register: (skill) => { skills.push(skill); return () => {}; } },
      systemPrompt: { section: (section) => { sections.push(section); return () => {}; } },
      agents: { currentInitiator: () => initiator, list: () => [root], ...registry },
      on: (event, handler) => {
        listeners.set(event, handler);
        return () => {};
      },
      get: (name) => {
        if (name === "subagents") return subagents;
        if (name === "llm") return llm;
        if (name === "subagentModelSelection") return settings;
        if (name === "tools") return { register: (definition) => { tools.push(definition); return () => {}; } };
        return undefined;
      },
      get subagents() {
        throw new Error('cannot get property "subagents" without inject');
      },
      home,
    },
  };
}

// The real LLM service answers asynchronously and advertises one provider at a
// time; this fake keeps that shape and fails one provider to prove the catalog
// keeps the routes the others returned.
const fakeLlm = {
  listProviders: () => [
    { id: "alpha", name: "Alpha" },
    { id: "beta", name: "Beta" },
  ],
  listModels: async (provider) => {
    if (provider === "beta") throw new Error("catalog unavailable");
    return [
      { provider: "alpha", id: "one", name: "Model One", description: "fast" },
      { provider: "alpha", id: "two", name: "Model Two" },
    ];
  },
  resolveModelInfo: async (provider, model) => ({
    provider,
    id: model,
    name: "Model One",
    reasoning: {
      defaultEffort: "high",
      efforts: [
        { id: "low", name: "Low" },
        { id: "high", name: "High", description: "the default balance" },
      ],
    },
  }),
};

function fakeSession(firstLiveSeq = 0) {
  const appended = [];
  return {
    firstLiveSeq,
    appended,
    append(type, data) {
      appended.push({ type, data });
    },
  };
}

test("the bundle registers every packaged skill with its frontmatter", () => {
  const skills = loadBundledSkills();
  expect(skills).toHaveLength(67);
  expect(skills.map((skill) => skill.name)).toContain("poteto-mode");
  for (const skill of skills) {
    expect(skill.description.length).toBeGreaterThan(0);
    expect(skill.content).not.toContain("---\nname:");
    expect(skill.resourceBase.kind).toBe("directory");
    expect(skill.path.endsWith("/SKILL.md")).toBe(true);
    expect(skill.source).toBe("bundled");
  }
  const principle = skills.find((skill) => skill.name === "principle-fix-root-causes");
  expect(principle.invocation).toEqual({ modelInvocable: true, userInvocable: false });
  const typescript = skills.find((skill) => skill.name === "typescript-best-practices");
  expect(typescript.metadata).toEqual({ paths: ["**/*.ts", "**/*.tsx"] });
});

test("frontmatter parsing handles quoted strings, booleans, and arrays", () => {
  const parsed = parseFrontmatter(
    '---\nname: demo\ndescription: "a \\"quoted\\" value"\nuser-invocable: false\npaths: ["a", "b"]\n---\nBody\n',
  );
  expect(parsed.data).toEqual({
    name: "demo",
    description: 'a "quoted" value',
    "user-invocable": false,
    paths: ["a", "b"],
  });
  expect(parsed.body).toBe("Body\n");
});

test("apply registers the catalog, the routing section, and the model sheet", () => {
  const home = mkdtempSync(join(tmpdir(), "pstack-dsh-"));
  writeFileSync(join(home, "pstack-models.md"), "arena runners: deepseek/reasoner @high\n");
  const { ctx, skills, sections } = fakeContext({ home });

  apply(ctx, { home });
  expect(skills).toHaveLength(67);
  expect(sections.map((section) => section.name)).toEqual(["pstack:routing", "pstack:models"]);
  expect(sections[0].text()).toContain("Invoke the `poteto-mode` skill");
  expect(sections[0].text()).not.toContain("pstack:poteto-mode");
  expect(sections[0].text()).toContain("dsh-tools.md");
  expect(sections[1].text()).toContain("arena runners:");
});

test("a subagent does not receive the routing mandate", () => {
  const { ctx, sections } = fakeContext({ initiator: { id: "child" }, root: { id: "root" } });
  apply(ctx);
  expect(sections[0].text()).toBe("");
});

test("a registry that still has roots() answers root membership", () => {
  const { ctx, sections } = fakeContext({
    initiator: { id: "child" },
    registry: { roots: () => [{ id: "root" }] },
  });
  apply(ctx);
  expect(sections[0].text()).toBe("");
});

test("an unresolved tree root keeps the routing mandate", () => {
  const { ctx, sections } = fakeContext({
    initiator: { id: "child" },
    rootOf: () => {
      throw new Error("UNAUTHORIZED");
    },
  });
  apply(ctx);
  expect(sections[0].text()).not.toBe("");
});

test("a profile without a subagent service keeps the routing mandate", () => {
  const { ctx, sections } = fakeContext({ initiator: { id: "child" } });
  ctx.get = () => undefined;
  apply(ctx);
  expect(sections[0].text()).not.toBe("");
});

test("a missing model sheet contributes nothing", () => {
  expect(readModelSheet(mkdtempSync(join(tmpdir(), "pstack-dsh-empty-")))).toBe("");
});

test("session hook: off stops the mandate but keeps the model sheet", () => {
  const home = mkdtempSync(join(tmpdir(), "pstack-dsh-off-"));
  writeFileSync(join(home, "pstack-models.md"), "session hook: off\narena runners: deepseek/reasoner @high\n");
  expect(hookOff(readModelSheet(home))).toBe(true);
  const { ctx, sections } = fakeContext({ home });
  apply(ctx, { home });
  expect(sections[0].text()).toBe("");
  expect(sections[1].text()).toContain("arena runners:");
});

test("routingText names unqualified DSH skills and the mapping", () => {
  const text = routingText();
  expect(text).toContain("`poteto-mode`");
  expect(text).not.toContain("`pstack:poteto-mode`");
  expect(text).toContain("AGENTS.md");
});

test("the DSH package validator accepts the bundle and rejects broken packaging", () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const files = new Set(["cordis.patch.yml", "plugins/pstack/dsh/index.mjs", "plugins/pstack/skills/poteto-mode/SKILL.md"]);
  const options = {
    pathExists: (rel) => files.has(rel),
    read: () => readFileSync(join(repoRoot, "cordis.patch.yml"), "utf8"),
  };
  expect(() => validateDshPackage(manifest, options)).not.toThrow();

  expect(() => validateDshPackage({ ...manifest, dsh: { bundle: { patch: "./other.yml" } } }, options)).toThrow(
    "dsh.bundle.patch must be ./cordis.patch.yml",
  );
  expect(() => validateDshPackage({ ...manifest, engines: { dsh: ">=0.3.0" } }, options)).toThrow(
    "engines.dsh must admit 0.2.2-rc.1",
  );
  expect(() => validateDshPackage(manifest, { ...options, pathExists: () => false })).toThrow(
    "names a file that does not exist",
  );
});

test("DSH Model names are generated from configured roles and panels", () => {
  const models = loadModels();
  expect(runtime.modelNames).toBe(dshModelNamesSection);
  const text = runtime.modelNames(models);
  for (const skill of roleSkills(models)) expect(text).toContain(`\`${skill}\``);
  expect(text).toContain("pstack-models.md");

  const fixture = runtime.modelNames({
    roles: [
      { skill: "dsh-fixture-worker", tier: "worker" },
      { skill: "dsh-fixture-panel", tier: "panel" },
      { skill: "dsh-fixture-panel", tier: "panel" },
    ],
  });
  expect(fixture).toContain("`dsh-fixture-worker`");
  expect(fixture).toContain("Diverse-model panels (`dsh-fixture-panel`)");
  expect(fixture).not.toContain("`arena`");
  expect(fixture).not.toContain("`architect`");
});

test("the catalog tool answers providers, models, and efforts like list_subagent_models", async () => {
  expect(await catalogText(fakeLlm)).toBe("alpha — Alpha\nbeta — Beta");
  expect(await catalogText(fakeLlm, { provider: "alpha" })).toBe(
    "alpha/one — Model One: fast\nalpha/two — Model Two",
  );
  const detail = await catalogText(fakeLlm, { provider: "alpha", model: "one" });
  expect(detail).toContain("alpha/one — Model One");
  expect(detail).toContain("low — Low");
  expect(detail).toContain("high (default) — High: the default balance");
  expect(await catalogText({ listProviders: () => [] })).toBe("(no LLM providers)");
  await expect(catalogText(fakeLlm, { provider: "missing" })).rejects.toThrow("is not registered");
  await expect(catalogText(fakeLlm, { model: "one" })).rejects.toThrow("`model` requires `provider`");
  await expect(catalogText(fakeLlm, { provider: "omega" })).rejects.toThrow("available providers: alpha, beta");
  await expect(catalogText(fakeLlm, { provider: "" })).rejects.toThrow("`provider` must be non-empty");
  await expect(catalogText(fakeLlm, { provider: "alpha", model: "" })).rejects.toThrow("`model` must be non-empty");
});

test("the catalog lists every advertised route and skips a provider whose catalog fails", async () => {
  expect(await catalogRoutes(fakeLlm)).toEqual([
    { provider: "alpha", model: "one" },
    { provider: "alpha", model: "two" },
  ]);
});

test("the bundle registers list_dsh_models for setup-pstack", async () => {
  const { ctx, tools } = fakeContext({ llm: fakeLlm });
  apply(ctx);
  const tool = tools.find((candidate) => candidate.name === "list_dsh_models");
  expect(tool).toBeDefined();
  expect(tool.parameters).toEqual({
    type: "object",
    properties: {
      provider: { type: "string", description: "Registered LLM provider id." },
      model: { type: "string", description: "Exact model id; requires provider." },
    },
  });
  expect(tool.output.schema).toEqual({ type: "string" });
  expect(tool.output.render({}, "alpha — Alpha")).toEqual([{ type: "text", text: "alpha — Alpha" }]);
  expect(await tool.execute({ provider: "alpha" }, {})).toContain("alpha/one — Model One");
  expect(await tool.execute({}, {})).toContain("alpha — Alpha");
});

test("apply tolerates a context without the model services", () => {
  const { ctx, tools } = fakeContext();
  expect(() => apply(ctx)).not.toThrow();
  expect(tools).toHaveLength(0);
});

test("a fresh Session gets the catalog as its model-selection policy", async () => {
  const { ctx, listeners } = fakeContext({ llm: fakeLlm });
  apply(ctx);
  const created = listeners.get("agent/created");
  expect(typeof created).toBe("function");

  const session = fakeSession();
  await created({ agent: { session } });
  expect(session.appended).toEqual([
    {
      type: "subagent/model-selection-policy",
      data: {
        allowedModels: [
          { provider: "alpha", model: "one" },
          { provider: "alpha", model: "two" },
        ],
      },
    },
  ]);
});

test("an enabled Host model-selection setting keeps ownership of the policy", async () => {
  const settings = { current: () => ({ enabled: true, allowedModels: [{ provider: "alpha", model: "one" }] }) };
  const { ctx, listeners } = fakeContext({ llm: fakeLlm, settings });
  apply(ctx);
  const session = fakeSession();
  await listeners.get("agent/created")({ agent: { session } });
  expect(session.appended).toEqual([]);
});

test("a resumed Session keeps the policy it recorded", async () => {
  const { ctx, listeners } = fakeContext({ llm: fakeLlm });
  apply(ctx);
  const session = fakeSession(4);
  await listeners.get("agent/created")({ agent: { session } });
  expect(session.appended).toEqual([]);
});

test("a policy append failure does not abort agent creation", async () => {
  const { ctx, listeners } = fakeContext({ llm: fakeLlm });
  apply(ctx);
  const session = {
    firstLiveSeq: 0,
    append() {
      throw new Error("session closed");
    },
  };
  await expect(listeners.get("agent/created")({ agent: { session } })).resolves.toBeUndefined();
});
