import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadModels } from "../tools/generate.mjs";
import { dshModelNamesSection, roleSkills, RUNTIMES, validateDshPackage } from "../tools/runtimes.mjs";
import { apply, hookOff, loadBundledSkills, parseFrontmatter, readModelSheet, routingText } from "../plugins/pstack/dsh/index.mjs";
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

function fakeContext({ initiator = { id: "root" }, roots = [{ id: "root" }], home } = {}) {
  const skills = [];
  const sections = [];
  return {
    skills,
    sections,
    ctx: {
      skills: { register: (skill) => { skills.push(skill); return () => {}; } },
      systemPrompt: { section: (section) => { sections.push(section); return () => {}; } },
      agents: { currentInitiator: () => initiator, roots: () => roots },
      home,
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
  const { ctx, sections } = fakeContext({ initiator: { id: "child" }, roots: [{ id: "root" }] });
  apply(ctx);
  expect(sections[0].text()).toBe("");
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
