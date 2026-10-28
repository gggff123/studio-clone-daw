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
npm run tauri:build -- --bundles nsis
```

Outputs:

- Portable binary: `src-tauri/target/release/studio-clone.exe`
- NSIS installer: `src-tauri/target/release/bundle/nsis/*-setup.exe`

The installer includes the offline Microsoft Edge WebView2 runtime and installs it silently when it is missing. The installer uses per-machine mode, so Windows will ask for Administrator approval.

Smoke-test both the portable executable and the installer before publishing:

1. Install with the NSIS installer and confirm the app launches.
2. Confirm the WebView2 runtime was installed automatically on a machine that did not have it.
3. Launch the portable executable and confirm the WASAPI output device is selected.
4. Create a MIDI part, add notes, play, and stop.
5. Save a project, reopen it, and verify media and MIDI persist.
6. Export a short WAV and confirm it has nonzero duration and audio.
7. Close the app with unsaved changes and verify the guard behaves correctly.

## Deployment release workflow

`.github/workflows/release.yml` is deployment-only. It does not run on pull requests. It runs when a `v*` tag is pushed or when **Release** is started manually with an existing tag.

It builds and publishes:

- Windows NSIS installer with the offline WebView2 runtime bundled
- Windows portable `.exe` and `.zip`
- Linux `.AppImage` and `.deb`

Trigger a release by pushing a tag:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

Or run **Release** from GitHub Actions and provide an existing tag. The workflow creates or updates a non-draft GitHub release with the built assets.

## Manual release checklist

- [ ] `npm run build`
- [ ] `npm run check:rust`
- [ ] `npm run test:rust`
- [ ] `npm run tauri:build -- --bundles nsis`
- [ ] NSIS installer launches and installs WebView2 automatically
- [ ] Portable executable launches and closes cleanly
- [ ] WAV export is nonzero and playable
- [ ] Project save/open/recovery round-trip works
- [ ] README limitations match the build
- [ ] Tag matches the manifests
- [ ] Release notes call out unsigned binaries and the installer's bundled WebView2 runtime
