# Contributing

Thanks for wanting to contribute to **@supabase-labs/y-supabase**!

## Getting started

1. Fork the repo and clone your fork.
2. Install dependencies — `pnpm install`
3. Create a feature branch — `git checkout -b my-change`
4. Make your changes, then run `pnpm test` and `pnpm typecheck`.
5. Commit using **Conventional Commits** (see below).
6. Open a Pull Request against `main`.

## Conventional Commits

This project uses [release-please](https://github.com/googleapis/release-please) to automate releases, so every commit that lands on `main` **must** follow the [Conventional Commits](https://www.conventionalcommits.org/) spec:

```
feat: add awareness support
fix: handle reconnection edge case
docs: update README examples
chore: bump dependencies
```

A `feat` commit bumps the minor version; a `fix` bumps the patch. Add a `!` or `BREAKING CHANGE` footer for breaking changes.

## Pull Requests

- All changes go through **fork → branch → PR** — no direct pushes to `main`.
- Keep PRs focused; one logical change per PR.
- Make sure CI is green before requesting review.
