# DeepSeek Harness tool mapping for pstack

DeepSeek Harness (DSH) uses this mapping regardless of its model provider. pstack installs as a native DSH bundle that registers the shared skill tree, injects the session-start routing into root sessions, and adds the `pstack` agent preset plus a `pstack_subagent` delegation tool, so no skill symlinks are needed. It adds no Pi extension and no shell hook. Check the current session's tool schemas: presets, executor modes, and delegation depth can change the exposed interfaces.

## Tool actions

| pstack / Claude action | DSH equivalent and boundary |
| --- | --- |
| Read a file (`Read`) | `read`, with path and line bounds. Use `read_image` when the file is an image and the preset exposes it. |
| Create a file (`Write`) | `write`. |
| Edit a file (`Edit`) | `edit`, with a literal replacement. |
| Find files (`Glob`) | `glob`. |
| Search contents (`Grep`) | `grep`. |
| Run a shell command (`Bash`) | `bash`, or the deployment's platform-specific shell tool. |
| Fetch a URL (`WebFetch`) | `web_fetch`, when the preset exposes it. |
| Search the web (`WebSearch`) | `web_search`, when the preset exposes it. |
| Invoke a skill (`Skill`) | `skill` by its catalog name. Request `poteto-mode` by name; Claude slash-command syntax is not assumed. |
| Dispatch a subagent (`Agent` / `Task`) | `subagent` for a self-contained brief; `subagent_fork` for conversation context. Use `pstack_subagent` for a pstack-role child from any preset, or `subagent` with `agent_preset: pstack` while the session runs the `pstack` preset. |
| Continue or steer a subagent (`SendMessage`) | `send_message`, with the returned agent ID. |
| List subagents | `list_agents`. |
| Stop a subagent | `interrupt_agent` requests a stop; observe completion before reusing its worktree. |
| Isolated worktree per delegate (`Agent` with `isolation: "worktree"`) | `create_delegate_worktree` where DSH's worktree runtime is mounted, then pass its `path` as `cwd`; otherwise create the checkout with `git worktree add`. See [Worktrees and pull requests](#worktrees-and-pull-requests). |
| Pull request control (`gh`, `origin pr`, `watch-pr`, `ship-pr`) | `gh` by default, `origin pr` when Origin's CLI resolves the repository, both through `bash`. The `watch-pr` and `ship-pr` commands are bun scripts. The change-request panel reads the Host's signed-in `gh`. |
| Track tasks (`TaskCreate`, `TaskUpdate`, `TodoWrite`) | `todo_write` replaces the complete list. If absent, use poteto-mode's checklist fallback. |
| Ask the human (`AskUserQuestion`) | `ask_user_question`, when the preset exposes it; a live child agent cannot call it. |
| Wait for shell output | `job_output`, with the background job ID and `wait: true` when blocked. |
| Cancel a background job | `job_kill`, for a job rather than an agent or Host. |
| Long-running objective | `create_goal`, only for a direct human long-running objective under DSH's goal contract. |
| `ScheduleWakeup` / recurring `loop` | No one-to-one equivalent. Use `schedule_create` with an RFC 5545 `rrule` and a target only for an explicit scheduling request. |

## Subagent policy

- `subagent` takes a short `description` and a complete `prompt`, plus `cwd` for a different working directory. `subagent_fork` inherits conversation context and uses its own schema; use `subagent` for independent reviews.
- `pstack_subagent` takes the same brief and `cwd` and always selects the `pstack` preset. Prefer it for `poteto-agent`, `comment-sicko`, and the review roles when the session does not run the `pstack` preset. The `pstack` preset's own `subagent` row allows `agent_preset: pstack`, so selecting that preset exposes the field on the built-in tool.
- Neither tool takes Claude Code's `subagent_type`, `readonly`, `isolation`, or `run_in_background`. Both return an agent ID immediately and run asynchronously.
- Names such as `pstack:poteto-agent` and `pstack:comment-sicko` are role instructions, not DSH agent types. Put the role, task boundary, skill paths, and expected result in the prompt.
- For a read-only reviewer, include that restriction in the brief; DSH has no `readonly` dispatch field. Report when filesystem enforcement is unavailable.
- For separate writing worktrees, prepare them before dispatch and pass each verified directory through `cwd`; there is no automatic `isolation` field. See [Worktrees and pull requests](#worktrees-and-pull-requests).
- Model overrides belong on `subagent` only when its live schema accepts them. Supply `provider` and `model` together, and select `reasoning_effort` from the catalog for that pair. Do not attach these fields to `subagent_fork` when its schema omits them.
- Delegation depth can remove child tools. A required independent review remains unverified when no child level is available.
- Completion arrives through the runtime. `send_message` confirms delivery, not findings; `interrupt_agent` confirms a stop request, not completion. `job_output` waits for shell jobs, not agents.

## Worktrees and pull requests

`subagent` and `pstack_subagent` have no `isolation` field, so a writing delegate gets its own checkout only when you create one and pass the path as `cwd`. The pstack bundle's `create_delegate_worktree` does that in one call: it creates a checkout under `.agents/worktrees/` through DSH's worktree runtime, returns its `path`, branch, base commit, and repository root, and restores the caller's directory. Pass `path` as the child's `cwd`. Claude Code's `isolation: "worktree"` branches from the remote default branch unless `worktree.baseRef` is `"head"`; name the same base here.

- `create_delegate_worktree` exists exactly where that runtime is mounted, which Web and Desktop expose as Change requests & worktrees. An existing name fails; omit `name` to generate one.
- Without the tool, create the checkout per child through `bash`: `git worktree add .agents/worktrees/<name> -b <branch> <base>`, then hand each child its path. Commit the base first when the child must build on commits the default branch lacks.
- `create_worktree` creates through the same runtime but moves the calling Session into the new checkout. Use it when the Session itself should work there, not for a child.
- A checkout created while the Session is already inside a worktree nests under that worktree's own `.agents/worktrees/`. The audit lists the nested checkout as its own row, and the pool's ignore file keeps the parent clean; remove the nested checkout before its parent.
- DSH reclaims a checkout when the Session whose log recorded it archives, unless the Plugins page's Keep worktrees switch is on. `create_delegate_worktree` and `create_worktree` record the checkout in the caller's log, so the caller must archive too. A `git worktree add` checkout is not tracked that way; clean it with the `worktree-cleanup` playbook.

Pull requests stay on the forge CLI. `gh` is the default and `origin pr` applies when Origin's CLI resolves the repository; run either through `bash`. GitHub status in the change-request panel comes from the Host's signed-in `gh`, so run `gh auth login --hostname <host>` once, and the panel lists a PR when the Session creates, opens, edits, or checks it out with `gh`. `skills/poteto-mode/scripts/` ships the `watch-pr` watcher and the `ship-pr` pending-merge command under `scripts/watch-pr/`; both are bun scripts, so install bun and invoke them by full path through `bash`. `resume.mjs` and `worktree-audit.mjs` run under node too, and the audit scans `$DSH_HOME/sessions` along with the other runtime transcript directories.

In poteto-mode's playbooks, `feature`, `autopilot-full`, and `autopilot-stack` give every writer or owner its own checkout, `shipping`, `babysit`, and `opening-a-pr` keep the forge on `gh` or `origin pr` and call `ship-pr` and `watch-pr`, and `worktree-cleanup` runs the audit, which now covers `${DSH_HOME:-~/.dsh}/sessions` and its `.jsonl.zstd` logs. `babysit` has no `/loop`, so re-run its check each turn, or create a `schedule_create` task only when the user asks for a cadence. `autopilot-full` keeps its program store under `${DSH_HOME:-~/.dsh}/orchestrate/<slug>/`, not `~/.claude/orchestrate/`. `worktree-cleanup` may also clear `${DSH_HOME:-~/.dsh}/cache`, but not `sessions`.

| Skill | On DeepSeek Harness |
| --- | --- |
| `setup-pstack` | Write `${DSH_HOME:-~/.dsh}/pstack-models.md`; the bundle injects it into the session prompt. Read the deployment catalog with `list_dsh_models` (no argument: providers; `provider`: its models; `provider` + `model`: its efforts) and write only the `provider/model` routes it lists. `list_subagent_models`, when exposed, names the routes the current Session authorizes. |
| `swarm` | Give every writing worker its own checkout with `create_delegate_worktree` (or `git worktree add` where it is absent), and pass that path through `cwd`. |
| `arena` | Put each candidate in its own output location, `create_delegate_worktree` where available; pass the path through `cwd`. |
| `interrogate` | Copy the scope's uncommitted changes into each adversary's checkout from `create_delegate_worktree` (or `git worktree add`), then pass that path through `cwd`. |
| `no-comments` | Run it in the Session's own directory, not a separate worktree, so it sees the scope's uncommitted changes. |

## Model names

DSH selects providers, models, and reasoning efforts through its current deployment. Do not pass Claude Code model aliases to DSH or use the Pi/Copilot mapping merely because the parent model comes from that provider. Read the deployment catalog with `list_dsh_models`, which the pstack bundle registers: no arguments names providers, `provider` lists its advertised models, and `provider` + `model` lists that model's reasoning efforts. `list_subagent_models`, when present, answers the narrower question: the routes this Session authorizes for subagent selection. A Session records that authorization once, at creation, from the Host's model-selection setting; while the Host leaves selection off, the bundle records the deployment catalog itself, so a model the sheet names from `list_dsh_models` is selectable. Without either tool, use the deployment's model settings or omit unsupported selectors. Pass `provider`, `model`, and `reasoning_effort` only when the live delegation schema accepts them; omit all selectors to use its documented defaults.

Roles used by `arena`, `interrogate`, `no-comments`, `poteto-mode`, `swarm`, `thermos` are prompt responsibilities, not DSH model IDs or built-in agent types. Diverse-model panels (`arena`, `interrogate`) require distinct available model families; report when that is unavailable. Do not manufacture diversity by relabeling the same model.

The bundle injects the role lines from `${DSH_HOME:-~/.dsh}/pstack-models.md` when that sheet exists; the lines are the user's saved choices, not resolved routes. `setup-pstack` writes them, `session hook: off` stops the routing mandate but keeps the role lines, and `inherit-parent` or `auto` omits `model` and `reasoning_effort`.
