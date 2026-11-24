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
- For separate writing worktrees, prepare them before dispatch and pass each verified directory through `cwd`; there is no automatic `isolation` field.
- Model overrides belong on `subagent` only when its live schema accepts them. Supply `provider` and `model` together, and select `reasoning_effort` from the catalog for that pair. Do not attach these fields to `subagent_fork` when its schema omits them.
- Delegation depth can remove child tools. A required independent review remains unverified when no child level is available.
- Completion arrives through the runtime. `send_message` confirms delivery, not findings; `interrupt_agent` confirms a stop request, not completion. `job_output` waits for shell jobs, not agents.

| Skill | On DeepSeek Harness |
| --- | --- |
| `setup-pstack` | Write `${DSH_HOME:-~/.dsh}/pstack-models.md`; the bundle injects it into the session prompt. Read the deployment catalog with `list_dsh_models` (no argument: providers; `provider`: its models; `provider` + `model`: its efforts) and write only the `provider/model` routes it lists. `list_subagent_models`, when exposed, names the routes the current Session authorizes. |
| `swarm` | Pass each worker's prepared worktree through `cwd`. |

## Model names

DSH selects providers, models, and reasoning efforts through its current deployment. Do not pass Claude Code model aliases to DSH or use the Pi/Copilot mapping merely because the parent model comes from that provider. Read the deployment catalog with `list_dsh_models`, which the pstack bundle registers: no arguments names providers, `provider` lists its advertised models, and `provider` + `model` lists that model's reasoning efforts. `list_subagent_models`, when present, answers the narrower question: the routes this Session authorizes for subagent selection. A Session records that authorization once, at creation, from the Host's model-selection setting; while the Host leaves selection off, the bundle records the deployment catalog itself, so a model the sheet names from `list_dsh_models` is selectable. Without either tool, use the deployment's model settings or omit unsupported selectors. Pass `provider`, `model`, and `reasoning_effort` only when the live delegation schema accepts them; omit all selectors to use its documented defaults.

Roles used by `arena`, `interrogate`, `no-comments`, `poteto-mode`, `swarm`, `thermos` are prompt responsibilities, not DSH model IDs or built-in agent types. Diverse-model panels (`arena`, `interrogate`) require distinct available model families; report when that is unavailable. Do not manufacture diversity by relabeling the same model.

The bundle injects the role lines from `${DSH_HOME:-~/.dsh}/pstack-models.md` when that sheet exists; the lines are the user's saved choices, not resolved routes. `setup-pstack` writes them, `session hook: off` stops the routing mandate but keeps the role lines, and `inherit-parent` or `auto` omits `model` and `reasoning_effort`.
