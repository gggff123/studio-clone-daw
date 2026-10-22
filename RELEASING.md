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

`.github/workflows/release.yml` builds:

- Windows portable `.exe` and `.zip`
- Linux `.AppImage` and `.deb`

Trigger it by pushing a tag:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

Or run **Release** from GitHub Actions and provide an existing tag. The workflow
creates a **draft** release so assets can be checked before publishing.

The workflow is intentionally conservative: it does not publish a non-draft release
without human review.

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
