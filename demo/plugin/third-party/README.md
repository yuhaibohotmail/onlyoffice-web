# Third-party file: OnlyOffice plugin bootstrap script

> English | [中文](README.zh.md)

`plugins.js`: **not written by this project**.

- Source: Ascensio System SIA's official plugin bootstrap script (the version that combines `pluginBase.js` + `plugins.js`)
- License: Apache License 2.0 (the original notice is kept at the top of the file)

## Why it is required, yet not in that 1.06 GB SDK package

Every OnlyOffice plugin needs it at startup: it handles the handshake with the editor (a `postMessage` carrying `initialize`),
then receives the `plugin_init` message the editor sends back and `eval`s the code in that message.
**APIs such as `Asc.plugin.executeMethod` are injected in that step**; they are not part of this script, and they are not in the SDK either.

A real Document Server ships it in the `sdkjs-plugins/` directory together with the plugins.
But the static SDK this project serves **lacks the entire `sdkjs-plugins/` directory**
(the packaging script would have fetched it; it just never made it into a commit), so a copy had to be obtained separately.

## Why not rewrite it ourselves

This handshake protocol could be written by hand, but **getting it wrong would make failures impossible to explain**: when the panel does not show up,
you could not tell whether "this front-end-only editor cannot run plugins" or "our handshake is wrong",
and the former is exactly the question this project is meant to answer. With the official script, a failure has only one explanation.
