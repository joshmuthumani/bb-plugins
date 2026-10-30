# bb-plugins

BB plugins maintained by Josh Muthumani. Each plugin lives in its own
`bb-plugin-*` directory and is installed from this repository with
`--subdirectory`.

## Plugins

| Plugin | Directory | Install tag prefix |
| --- | --- | --- |
| PR Tracker — open pull requests with check status and a Merge button in the right panel | `bb-plugin-pr-tracker` | `pr-tracker-` |
| LSP — TypeScript/JavaScript hover, completion, and diagnostics in a Monaco file editor | `bb-plugin-lsp` | `lsp-` |

## Install

```sh
bb plugin install git:https://github.com/joshmuthumani/bb-plugins \
  --subdirectory bb-plugin-pr-tracker --yes
```

Versioned:

```sh
bb plugin install git:https://github.com/joshmuthumani/bb-plugins@0.1.0 \
  --subdirectory bb-plugin-pr-tracker --tag-prefix pr-tracker- --yes
```

Each plugin's `dist/` is committed because git installs load prebuilt
artifacts. See the plugin README for configuration and development notes.
