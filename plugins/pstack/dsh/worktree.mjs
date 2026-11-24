// Worktree creation for a delegated writer.
//
// DSH's `create_worktree` creates a checkout and then moves the calling
// Session into it, which suits a Session that wants to work there. pstack needs
// the opposite when it fans writers out: every child gets its own checkout
// while the caller keeps its directory, so it can dispatch the next child from
// the checkout the work belongs to. This plugin wraps the same worktree runtime
// and restores the caller's directory after creation, so both share one owner
// of the checkout pool, its ignore file, and its archive cleanup.

export const name = "pstack-worktree";
export const inject = ["tools", "worktrees", "workingDirectory"];

export const TOOL = "create_delegate_worktree";

// The record the worktree runtime returns. Keeping the shape identical to
// `create_worktree` lets a model that learned one tool read the other.
const RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    branch: { type: "string" },
    baseCommit: { type: "string" },
    repositoryRoot: { type: "string" },
  },
  required: ["path", "branch", "baseCommit", "repositoryRoot"],
};

// Restoring the caller's directory is the whole point of the tool, so a
// creation that moved it and then failed still restores it before the error
// leaves. `workingDirectory.set` without a signal runs even when the call was
// cancelled, because a moved directory would otherwise outlive the failure.
async function createAndRestore(ctx, agent, request, signal) {
  const origin = ctx.workingDirectory.get(agent.session);
  let created;
  try {
    created = await ctx.worktrees.create(agent, request, signal);
  } catch (error) {
    if (ctx.workingDirectory.get(agent.session) !== origin) {
      await ctx.workingDirectory.set(agent, origin).catch(() => {});
    }
    throw error;
  }
  try {
    await ctx.workingDirectory.set(agent, origin);
  } catch (error) {
    throw new Error(
      `created worktree ${created.branch} at ${created.path}, but the caller's directory ` +
        `${origin} could not be restored: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return created;
}

function definition(ctx) {
  return {
    name: TOOL,
    description:
      "Create a Git worktree for a delegated writer and keep this session's own directory. " +
      "Returns the checkout's path, branch, base commit, and repository root; pass `path` as the child's `cwd`. " +
      "Uses the same runtime as create_worktree, which moves the caller instead. " +
      "An existing name fails; omit `name` to generate one. Uncommitted files stay in the source checkout.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "New branch name, also used as the checkout directory: a few lowercase words joined by hyphens, such as fix-login-retry. Omit to generate one.",
        },
        from: {
          type: "string",
          description: "Local commit, branch, or tag to start from. Defaults to HEAD; no fetch is performed.",
        },
      },
    },
    output: {
      schema: RECORD_SCHEMA,
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    // Creation changes the caller's directory twice, so the call must not share
    // a batch with another tool that resolves a relative path.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error(`${TOOL} requires a calling agent`);
      return createAndRestore(ctx, exec.agent, args, exec.signal);
    },
  };
}

export function apply(ctx) {
  ctx.tools.register(definition(ctx));
}
