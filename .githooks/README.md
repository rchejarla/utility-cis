# Git hooks

One-time setup after `git init`:

```bash
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
```

## What runs on `git commit`

1. `tsc --noEmit` on `@utility-cis/shared`
2. `tsc --noEmit` on `@utility-cis/api`
3. `vitest run` on `@utility-cis/api`
4. `vitest run` on `@utility-cis/shared`

Any failure blocks the commit. To bypass in an emergency (discouraged):

```bash
git commit --no-verify
```

## Why a shell hook instead of husky

Husky adds a dependency, a `prepare` script, and another `node_modules` entry to
audit. This project's hook logic is three lines — plain `.githooks/` is simpler,
has zero install surface area, and survives `rm -rf node_modules`.
