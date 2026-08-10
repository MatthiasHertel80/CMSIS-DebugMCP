# esbuild bundling — prepared, not enabled

Upstream `microsoft/DebugMCP` bundles the extension into a single
`dist/extension.js` with esbuild and excludes `node_modules` from the VSIX.
This fork has the build script (`esbuild.js`) but **still ships unbundled
`out/*.js`**, because the change could not be verified here.

## Why it is not on

`esbuild` could not be installed in the environment where this was prepared.
Five attempts, all failing the same way:

```
npm error code ETIMEDOUT
npm error network request to https://registry.npmjs.org/esbuild/-/esbuild-0.28.0.tgz
          failed, reason: read ETIMEDOUT
```

The `@esbuild/*` platform packages fetched fine; the `esbuild` tarball itself
times out. That is a proxy / network problem on that machine, **not** anything
about this repo — so on a normal connection step 1 below should simply work.
Note the failure mode: one attempt left `node_modules/esbuild` as an *empty
directory* rather than erroring, so check the package actually resolves
(`node -e "require('esbuild')"`) before trusting an install that reported
success.

Without a working esbuild there is no way to build the bundle, let alone
package a VSIX and check that the serial backend still loads. Turning the
switches on regardless would have left `main` pointing at a `dist/` that nobody
had ever produced.

The plan for this work set an explicit gate: if the native-module story could
not be pinned down quickly, keep `tsc`-only packaging, because the size win is
not worth a broken serial backend. That is what happened.

## What is already done

- [`esbuild.js`](../esbuild.js) — complete, with `serialport` marked external.
- The serialport dependency closure below, derived from the installed tree
  rather than guessed.

## Why `serialport` must stay external

`serialport` loads a native `.node` binary through `node-gyp-build`, which
resolves the prebuild directory **relative to `__dirname` at runtime**. Bundling
that code moves `__dirname` to `dist/`, the lookup fails, and every serial tool
dies at its first call — with an error that reads like a missing driver rather
than a packaging mistake. So the bundle excludes it and the VSIX must still
carry its subtree.

## To finish it

1. `npm install --save-dev esbuild@^0.28.0`
   (upstream pins `^0.28.1`, which does not exist in the registry — `0.28.0` is
   the newest published version.)

2. `package.json`:
   ```json
   "main": "./dist/extension.js",
   "scripts": {
     "vscode:prepublish": "npm run package",
     "bundle": "node esbuild.js",
     "package": "npm run check-types && node esbuild.js --production"
   }
   ```

3. `.vscodeignore` — add `out/**` and `dist/**/*.map`, then replace the
   `node_modules` note with:

   ```
   node_modules/**
   !node_modules/serialport/**
   !node_modules/@serialport/**
   !node_modules/node-addon-api/**
   !node_modules/node-gyp-build/**
   !node_modules/debug/**
   !node_modules/ms/**
   ```

   Regenerate that list after any `serialport` upgrade:

   ```sh
   node -e "const s=new Set();(function w(p){if(s.has(p))return;s.add(p);
     let j;try{j=require('./node_modules/'+p+'/package.json')}catch(e){return}
     for(const d of Object.keys(j.dependencies||{}))w(d)})('serialport');
     console.log([...s].sort().join('\n'))"
   ```

4. **Verify on the real artifact, not in the workspace.** A missing entry in
   that allow-list fails only in the packaged extension — in development the
   whole tree is present and everything looks fine. So:

   ```sh
   npx --yes @vscode/vsce package --allow-star-activation
   "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
     --install-extension cmsis-debugmcp-<version>.vsix --force
   ```

   Reload the window, then call `serial_list_ports` and `serial_open`. If the
   native binding fails to load, revert to `tsc`-only rather than chasing it —
   that is the gate.

5. `npm run test:transport` must still pass against the bundle.
