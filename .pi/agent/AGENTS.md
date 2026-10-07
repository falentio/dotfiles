# Global instructions

## Tools run through codemode

A tool pi does not declare is still callable from a codemode script as `tools.<name>(args)`: `tools.bash({ command })`, `tools.read({ path })`, `tools.mcp__t3_code__delegate_task({ task })`. The name uses underscores where the tool's name has hyphens. With `codemode.mode: "only"`, only `codemode` and `todo` are declared, so reach every other tool this way.

## Lookups

Context7 owns library documentation; TinyFish owns everything else, a library's changelog included. A named library's API surface, configuration, and code examples go to the `find-docs` skill. Release notes, migration announcements, news, papers, and general facts go to the `tinyfish-search-fetch` skill.

## Research runs in a subagent

A lookup that needs one query runs here. Anything wider, such as several queries or sources you must read and reconcile, runs in a `tools.mcp__t3_code__delegate_task` subagent: this context keeps the answer, the child thread keeps the search ceremony.

Follow up by messaging that child thread, which still knows what it found. Read [resuming-subagents.md](/home/kevin/.pi/agent/docs/resuming-subagents.md) for the two handles, the resume call, retrying a lost call, and the gotchas.
