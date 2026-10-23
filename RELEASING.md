# Releasing Studio Clone

## Versioning

- Application version lives in `package.json` and both Cargo manifests.
- Git tags use `v<major>.<minor>.<patch>`, for example `v0.1.0`.
- Project files have their own schema version (`formatVersion`), independent of the app version.

## Local Windows build

```powershell
npm ci
npm run build
npm run check:rust
npm run test:rust
npm run tauri:build:exe
```

The portable binary is written to `src-tauri/target/release/studio-clone.exe`.

Smoke-test the executable before publishing:

1. Launch it and confirm the WASAPI output device is selected.
2. Create a MIDI part, add notes, play, and stop.
3. Save a project, reopen it, and verify media and MIDI persist.
4. Export a short WAV and confirm it has nonzero duration and audio.
5. Close the app with unsaved changes and verify the guard behaves correctly.

## CI release workflow

`.github/workflows/ci.yml` runs the frontend build, Rust check, and core tests on
Windows for pull requests and pushes to `main`.

After a push to `main` passes CI, `.github/workflows/release.yml` automatically
builds and publishes a Windows portable `.exe` and `.zip`. Each release increments
the patch version from the latest published release (or starts from the version in
`package.json` if there is no published release). The generated tag and build
metadata use the same version.

Windows 7 is not supported by the current Tauri 2.12 toolchain. The Windows release
targets Windows 10/11 x64.

Releases are published automatically after successful CI; review the workflow run
and release assets in GitHub after each push to `main`.

## Manual release checklist

- [ ] `npm run build`
- [ ] `npm run check:rust`
- [ ] `npm run test:rust`
- [ ] `npm run tauri:build:exe`
- [ ] Portable executable launches and closes cleanly
- [ ] WAV export is nonzero and playable
- [ ] Project save/open/recovery round-trip works
- [ ] README limitations match the build
- [ ] Tag matches the manifests
- [ ] Release notes call out unsigned binaries and WebView2 requirements
