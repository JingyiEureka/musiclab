# Vendored library patches

## signalsmith-stretch.mjs

Source: `npm signalsmith-stretch@1.3.2` (MIT), file `SignalsmithStretch.mjs`,
fetched unmodified from jsDelivr and then patched as below.

### Patch 1: `setTimeMap` remote method

**Where:** inside `registerWorkletProcessor`, in the `remoteMethods` object,
immediately after `configure`.

**Why:** the library's `schedule()` is designed for realtime use. It prunes the
time map relative to each call's `outputTime` with two loops:

```js
while (timeMap.length && timeMap[timeMap.length - 1].output >= outputTime) pop()
...
while (timeMap.length > 1 && timeMap[1].output <= outputTime) shift()
```

To add breakpoint *k* while keeping earlier ones, the first loop requires
`T[k-1] < outputTime` and the second requires `T[1] > outputTime`. Together that
demands `T[1] > T[k-1]`, which contradicts ascending order for any k >= 2. So a
map pre-loaded before `startRendering()` retains at most **two** entries,
regardless of what `outputTime` is passed. The failure is silent: the render
succeeds using only the last section's rate, back-extrapolated from t=0, which
looks plausible.

Offline rendering knows every breakpoint up front and needs no pruning, so this
adds a direct setter. `process()` still prunes as playback time advances, which
is correct.

**The patch:**

```js
setTimeMap: entries => {
    let template = this.timeMap[0];
    this.timeMap = entries.map(e => Object.assign({}, template, e));
    return this.timeMap.length;
},
```

Entries are merged over `timeMap[0]` so they inherit the defaults the processor
expects (`semitones`, `tonalityHz`, `formantSemitones`, `formantCompensation`,
`formantBaseHz`, `loopStart`, `loopEnd`). Callers supply `output`, `input`,
`rate`, `active`, sorted ascending by `output`.

The wrapper exposes remote methods dynamically from `methodArgCounts`, so
`node.setTimeMap(entries)` is available with no client-side change.

### Patch 2: cache the worklet module blob URL

**Where:** in `createNode`, in the `catch` branch that registers the worklet
module, immediately after `URL.createObjectURL(...)`.

**Why:** the library builds the worklet module source into a Blob and calls
`URL.createObjectURL` on it, but never stores or revokes the result. Every
offline render creates a fresh `OfflineAudioContext`, so every render minted
another ~111 KB blob URL that lives until the page unloads. A long editing
session with repeated previews would accumulate tens of MB, which matters on
mobile.

`createNode.moduleUrl` is already read at the top of that branch as an override
hook, so caching into it reuses the same module for every later context.

**The patch:**

```js
createNode.moduleUrl = moduleUrl;
```

Bonus: this is also the Safari escape hatch. If `addModule(blobURL)` misbehaves
on iOS, set `createNode.moduleUrl` to a statically served copy of the worklet
module before the first render and no Blob is created at all.

### On upgrading

Re-apply this patch after any version bump, and re-run
`static/dev/stretch-test.html`. Test 5.2 (multi-breakpoint survival) fails
loudly if the patch is missing -- it is there specifically to catch that.

Worth upstreaming: an offline/batch entry point is generally useful and the
change is additive.
