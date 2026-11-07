# bb-plugin-linear-docs

Creates Linear documents from bb. The bundled `linear` plugin has no document
command, so this plugin calls Linear's GraphQL `documentCreate` mutation.

## Setup

```sh
cd bb-plugin-linear-docs
npm install
bb plugin install .
bb plugin config linear-docs set apiKey <linear-personal-api-key>
bb plugin config linear-docs set teamId <team-id>      # optional default
bb plugin config linear-docs set projectId <project-id> # optional default
```

The API key is a secret setting, stored on the server and never printed.

## Usage

```sh
bb linear-docs create "Launch plan" --body-file plan.md
bb linear-docs create "Notes" --team <team-id> --json
```

Options: `--body-file <path>` (markdown, max 1 MB), `--team <id>`,
`--project <id>`, `--json`. Title is 1 to 200 characters.

## Build

```sh
bb plugin build .
```

## Status

Live-tested: `bb linear-docs create` created a Linear document. The test
document was deleted in Linear.
