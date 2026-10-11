# Verified CV facts (research pass)

Every fact below was read from a file or a live GitHub API call on 2026-10-11.
Local clones live at /home/kevin/Repositories/<repo>. Repos with no local clone
were read through `gh api`.

## meowvie (Go, 28 stars, deployed at https://meowvie.falentio.com)

Three repositories form one product:
- meowvie (Go backend), meowvie-collector (Node/TS crawler monorepo),
  meowvie-frontend (Deno Fresh front end).

Facts:
- Go backend uses Fiber, Bleve full-text search, GORM over SQLite, and an LRU
  cache in front of the movie repository.
  evidence: go.mod lists gofiber/fiber/v2, blevesearch/bleve v1.0.14, gorm.io/gorm,
  hashicorp/golang-lru (read via `gh api repos/falentio/meowvie/contents/go.mod`)
  evidence: internal/movie_repo_lru.go and internal/search_bleve.go exist in the
  tree (read via `gh api .../git/trees/main?recursive=1`)
- The repo carries counterfeiter fakes and Go tests for search, service, repo,
  signer, and main.
  evidence: internal/internalfakes/fake_search.go, internal/search_test.go,
  internal/movie_service_test.go (same tree listing)
- The README documents a load test: 30 concurrent queries against a 256 MB
  instance, slowest response around 500 ms, 29.8 req/s over 10 s using oha.
  evidence: README.md, Performance section (read via `gh api .../contents/README.md`)
- The crawler is an npm workspaces monorepo with six site scrapers.
  evidence: meowvie-collector package.json workspaces array lists apps/oploverz,
  apps/otakudesu, apps/kazefuri, apps/melong, apps/samehadaku, apps/kusonime and
  packages/client
- The front end is Deno Fresh with islands and typed API routes.
  evidence: meowvie-frontend tree lists fresh.gen.ts, islands/Search.tsx,
  routes/api/search.ts

## commandcode (Go + TypeScript, 4 repos, most recent work)

Repos: commandcode-api, opencode-commandcode, opencode-pstack, opencode-todo.

Facts:
- commandcode-api is an OpenAI-compatible gateway written in Go with the standard
  library. It serves /v1/chat/completions and /v1/models, rotates API keys
  round-robin, and wraps the mux with CORS and request logging middleware.
  evidence: commandcode-api/main.go mux.HandleFunc calls and withCORS/withLogger;
  commandcode-api/handlers.go roundRobinKey and parseAPIKeys
- The Go service ships a Dockerfile, a systemd unit, and a fly.toml, plus a Deno
  TypeScript variant of the same handlers.
  evidence: commandcode-api tree lists Dockerfile, fly.toml,
  commandcode-api.service, deno/handlers.ts
- The model list it advertises spans Anthropic, OpenAI, DeepSeek, Moonshot, zai,
  MiniMax, Xiaomi, Qwen, StepFun, Google, and Nvidia models.
  evidence: commandcode-api/handlers.go handlerListModels literal model array
- opencode-commandcode is an OpenCode v2 plugin that fetches the remote model
  catalog, generates provider model configs, starts a local proxy, and registers
  an OpenAI-compatible provider. It uses Effect and vitest, and carries six test
  files.
  evidence: opencode-commandcode/src/index.ts COMMAND_CODE_PROVIDER_PACKAGE,
  fetchCommandCodeCatalog, startCommandCodeProxy; package.json test script;
  tree count 6 test files, 25 total
- opencode-pstack ports the pstack agent-workflow skill set to OpenCode and
  carries 201 tracked files with 8 test files.
  evidence: opencode-pstack/README.md first paragraph; tree count
- opencode-todo gives the agent a phased todo tool with nine operations and adds
  a /todo command.
  evidence: opencode-todo/README.md "nine operations" table

## ty (TypeScript, published to JSR)

- A typed event emitter library published as jsr:@falentio/ty, with Deno and npm
  install paths, zero dependencies, event filtering, and async listener support.
  evidence: ty/README.md Features and Installation sections
- Repo carries coverage tooling, lefthook hooks, and tests.
  evidence: ty/coverage, ty/lefthook.yml, ty/deno.json; tree count 1 test file

## art-trace (SvelteKit)

- A SvelteKit app using Drizzle ORM over libSQL, Tailwind v4, bits-ui, valibot,
  formsnap, and Playwright with vitest browser mode, deployed to Cloudflare
  Workers, calling Gemini through @google/genai.
  evidence: art-trace/package.json dependencies and scripts
- 133 tracked files, 73 of them .svelte.
  evidence: tree count

## image-storage (TypeScript, Cloudflare Workers)

- An image service on Hono for Cloudflare Workers that signs imgproxy URLs, using
  jose for JOSE, HKDF key derivation, valibot validation, and vitest.
  evidence: image-storage/package.json dependencies and scripts
- 20 tracked files with 12 TypeScript sources.
  evidence: tree count

## llm (TypeScript monorepo)

- A contract-first pnpm monorepo for an OpenRouter-compatible LLM gateway on
  LiteLLM, with oRPC + valibot contracts, better-auth, and Drizzle over
  Turso/libSQL. The README says the contract layer is in place and the server is
  not yet built.
  evidence: llm/README.md Architecture and Status sections;
  packages/contract listed in the packages dir

## sinnau.com (SvelteKit, 1536 files)

- The largest repo. SvelteKit on Cloudflare with better-auth, Drizzle D1, the Vercel
  AI SDK, alchemy for deploy, layerchart, and 66 test files. No README beyond the
  `sv` scaffold text, so there is no product description to quote.
  evidence: sinnau/package.json dependencies; tree count 66 test files

## dotfiles (460 files)

- An idempotent POSIX shell installer that symlinks ~/.pi and ~/.agents into the
  repo, backs up real files with a timestamp, and leaves foreign symlinks alone.
  evidence: dotfiles/link.sh link_one function and header comment
- Hosts the agent skills the workflow uses.
  evidence: .agents/skills directory listing

## Cut from the CV

- image-storage, llm, sinnau.com: real work, but the repos carry no product
  description and too little verified substance for a CV bullet that a recruiter
  can check. Kept out rather than padded with adjectives.

## Resume framing

No employment history, education, or location exists in any public source that was
read. The CV is built as a projects-and-skills CV, which is what the evidence
supports. Contact is the GitHub profile and the commit email found in the local
clones: kfalentio@proton.me.
evidence: `git log -1 --format=%ae` in /home/kevin/Repositories/ty,
/home/kevin/Repositories/opencode-pstack, /home/kevin/Repositories/dotfiles
