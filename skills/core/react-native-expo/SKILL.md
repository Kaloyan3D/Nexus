---
name: react-native-expo
description: >
  Use for React Native and Expo engineering: navigation lifecycle, native
  dependency alignment, prebuild projects, safe areas, keyboard behavior, and
  native CI. Expo export and web bundling are not substitutes for a real
  Gradle/Xcode build.
---

# React Native + Expo

## When to use

Use for any React Native code change, Expo Router work, dependency changes in
an Expo project, native project (android/ios) maintenance, or mobile CI
questions.

## Workflow

1. **Check the toolchain alignment first.** Before adding or upgrading
   anything, read package.json versions and run `npx expo-doctor` and
   `npx expo install --check`. Mismatched React Native / Expo SDK / native
   module versions produce failures that look like code bugs.
2. **Install through Expo when the package has native code.** Use
   `npx expo install <pkg>` (or check the SDK's bundled version table) so the
   native dependency versions stay compatible with the SDK.
3. **Know which project shape you are in.** Managed workflow (CNG) has no
   android/ios directories until prebuild; a prebuild-generated project
   contains native code that manual edits, clean clones, and `expo prebuild
   --clean` can conflict with. Never edit generated native files without
   stating the regeneration strategy.
4. **Respect Expo Router lifecycle.** Route components mount per focused
   route; tabs stay mounted by default when switching, stack screens may
   unmount on pop. State that must survive navigation lives outside the
   component tree (canonical store, persistent storage), not in component
   state.
5. **Handle safe areas and keyboard deliberately.** Use SafeArea
   primitives from the project's existing setup; test keyboard-adjacent
   screens with software keyboard visible, on both platforms' behaviors
   (resize/pan modes differ).
6. **Verify on a real native build.** `npx expo export` bundles JS and does
   NOT compile native code; it proves nothing about Gradle/Xcode success,
   native module linkage, or device behavior. JS-only success is reported as
   JS-only.

## Rules

- Never upgrade React Native, Expo SDK, or native modules ad hoc in an
  unrelated task without flagging the SDK alignment cost.
- Never claim "build verified" from `expo export`, Metro bundler success, or
  web output. Only a real native build (Gradle assemble, Xcode archive/
  build, or EAS build) verifies the native application.
- Platform divergence is handled explicitly (`Platform.select`, file
  extensions), not by testing on one platform and assuming the other.
- CI for native apps includes the native build job, not only Jest and lint.

## Verify completion

- `expo-doctor` and `expo install --check` ran (or their result is stated).
- Navigation lifecycle behavior matches what the task claims (mounted tabs,
  remount on refocus).
- The claim about build verification names the exact build that ran.
- Both target platforms considered; divergences listed.
