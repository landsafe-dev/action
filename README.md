# landsafe-dev/action

The Landsafe GitHub Action — catches the Postgres migration that takes production down, before it merges. See [landsafe.dev](https://landsafe.dev) for what it does and how to use it.

## Usage

```yaml
# .github/workflows/landsafe.yml
name: Landsafe
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  landsafe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: landsafe-dev/action@v1
        with:
          license: ${{ secrets.LANDSAFE_LICENSE }} # optional — Pro
```

## About this repo

This is the published mirror of the Action — what actually runs is `dist/index.cjs`, a bundled build. `src/` is included for transparency but won't build standalone here; it's developed as part of the main Landsafe monorepo alongside the engine and CLI, and synced here on release.

Full docs, the rule reference, and the source repo: [landsafe.dev](https://landsafe.dev)
