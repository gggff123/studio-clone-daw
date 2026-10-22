use crate::project::{AudioClip, Project, FORMAT_VERSION};
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingMedia {
    pub track_id: String,
    pub clip_id: String,
    pub media_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub path: String,
    pub project: Project,
    pub copied_files: Vec<String>,
    pub backup_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub path: String,
    pub project: Project,
    pub missing_media: Vec<MissingMedia>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutosaveEntry {
    pub path: String,
    pub project_name: String,
    pub project_id: String,
    pub modified_at: String,
    pub size: u64,
}

fn temp_sibling(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "project.cproj".into());
    path.with_file_name(format!(".{}.{}.tmp", name, uuid::Uuid::new_v4()))
}

/// Write a file, flush it to disk, then atomically replace the destination.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }
    let tmp = temp_sibling(path);
    {
        let mut file = fs::File::create(&tmp)
            .map_err(|e| format!("Cannot create temporary project file: {e}"))?;
        file.write_all(bytes)
            .map_err(|e| format!("Cannot write project data: {e}"))?;
        file.flush()
            .map_err(|e| format!("Cannot flush project data: {e}"))?;
        let _ = file.sync_all();
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Cannot replace {}: {e}", path.display())
    })
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Project".into())
}

fn media_dir_for(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!("{}.media", file_stem(path)))
}

fn unique_destination(dir: &Path, source: &Path) -> PathBuf {
    let file_name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "audio.wav".into());
    let mut candidate = dir.join(&file_name);
    if let (Ok(a), Ok(b)) = (fs::metadata(&candidate), fs::metadata(source)) {
        if a.len() == b.len() {
            return candidate;
        }
    }
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(&file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "audio".into());
    let ext = Path::new(&file_name)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for index in 1..10_000 {
        candidate = dir.join(format!("{stem}-{index}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
        if let (Ok(a), Ok(b)) = (fs::metadata(&candidate), fs::metadata(source)) {
            if a.len() == b.len() {
                return candidate;
            }
        }
    }
    dir.join(format!("{stem}-{}{ext}", uuid::Uuid::new_v4()))
}

/// Consolidate external audio into `<project>.media` and store portable
/// relative media references. The returned project keeps resolved absolute
/// paths so the live application can continue using the files immediately.
pub fn save_project(path: &Path, project: &Project) -> Result<SaveResult, String> {
    if path.as_os_str().is_empty() {
        return Err("No project path supplied.".into());
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .map_err(|e| format!("Cannot create project folder {}: {e}", parent.display()))?;
    let media_dir = media_dir_for(path);
    let mut persisted = project.clone();
    persisted.sanitize();
    let mut copied_files = Vec::new();
    let mut needs_media_dir = false;

    for track in &mut persisted.tracks {
        for clip in &mut track.clips {
            if clip.media_path.trim().is_empty() {
                continue;
            }
            let original = PathBuf::from(&clip.media_path);
            let absolute = if original.is_absolute() {
                original
            } else {
                parent.join(&original)
            };
            if !absolute.exists() {
                // Keep missing references so the user can relink them later.
                continue;
            }
            let inside_media_dir = absolute
                .parent()
                .and_then(|p| p.canonicalize().ok())
                .zip(media_dir.canonicalize().ok())
                .map(|(p, m)| p == m)
                .unwrap_or(false);

            let destination = if inside_media_dir {
                absolute.clone()
            } else {
                needs_media_dir = true;
                fs::create_dir_all(&media_dir).map_err(|e| {
                    format!("Cannot create media folder {}: {e}", media_dir.display())
                })?;
                let dest = unique_destination(&media_dir, &absolute);
                if !dest.exists() {
                    fs::copy(&absolute, &dest).map_err(|e| {
                        format!(
                            "Cannot copy media {} to {}: {e}",
                            absolute.display(),
                            dest.display()
                        )
                    })?;
                    copied_files.push(dest.to_string_lossy().to_string());
                }
                dest
            };

            if let Ok(relative) = destination.strip_prefix(parent) {
                clip.media_path = relative.to_string_lossy().to_string();
            } else {
                clip.media_path = destination.to_string_lossy().to_string();
            }
        }
    }

    if needs_media_dir {
        let _ = fs::create_dir_all(&media_dir);
    }

    let json = serde_json::to_vec_pretty(&persisted)
        .map_err(|e| format!("Cannot serialize project: {e}"))?;

    let backup_path = if path.exists() {
        let backup = path.with_file_name(format!(
            "{}.{}.bak",
            path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "project.cproj".into()),
            timestamp()
        ));
        match fs::copy(path, &backup) {
            Ok(_) => Some(backup.to_string_lossy().to_string()),
            Err(_) => None,
        }
    } else {
        None
    };

    atomic_write(path, &json)?;

    Ok(SaveResult {
        path: path.to_string_lossy().to_string(),
        project: project.clone(),
        copied_files,
        backup_path,
    })
}

pub fn load_project(path: &Path) -> Result<OpenResult, String> {
    let bytes = fs::read(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let mut project: Project = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Invalid project file {}: {e}", path.display()))?;

    if project.format_version > FORMAT_VERSION {
        return Err(format!(
            "This project was created by a newer version (format {}, supported {}).",
            project.format_version, FORMAT_VERSION
        ));
    }
    project.sanitize();
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut missing_media = Vec::new();

    for track in &mut project.tracks {
        for clip in &mut track.clips {
            if clip.media_path.trim().is_empty() {
                continue;
            }
            let media = PathBuf::from(&clip.media_path);
            if !media.is_absolute() {
                let resolved = parent.join(&media);
                clip.media_path = resolved.to_string_lossy().to_string();
            }
            if !Path::new(&clip.media_path).exists() {
                missing_media.push(MissingMedia {
                    track_id: track.id.clone(),
                    clip_id: clip.id.clone(),
                    media_path: clip.media_path.clone(),
                });
            }
        }
    }

    Ok(OpenResult {
        path: path.to_string_lossy().to_string(),
        project,
        missing_media,
    })
}

pub fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Compact UTC timestamp without pulling in a date/time dependency.
    format!("{secs}")
}

fn safe_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        "Project".into()
    } else {
        trimmed.chars().take(60).collect()
    }
}

pub fn autosave_project(dir: &Path, project: &Project) -> Result<String, String> {
    fs::create_dir_all(dir).map_err(|e| format!("Cannot create autosave folder: {e}"))?;
    let path = dir.join(format!(
        "{}-{}-{}.cproj",
        safe_name(&project.name),
        &project.id.chars().take(8).collect::<String>(),
        timestamp()
    ));
    let json = serde_json::to_vec_pretty(project)
        .map_err(|e| format!("Cannot serialize autosave: {e}"))?;
    atomic_write(&path, &json)?;
    prune_autosaves(dir, 12);
    Ok(path.to_string_lossy().to_string())
}

fn prune_autosaves(dir: &Path, keep: usize) {
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<_> = read
        .flatten()
        .filter(|e| e.path().extension().map(|x| x == "cproj").unwrap_or(false))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some((meta.modified().ok()?, e.path()))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in files.into_iter().skip(keep) {
        let _ = fs::remove_file(path);
    }
}

pub fn list_autosaves(dir: &Path) -> Vec<AutosaveEntry> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<AutosaveEntry> = read
        .flatten()
        .filter(|e| e.path().extension().map(|x| x == "cproj").unwrap_or(false))
        .filter_map(|e| {
            let path = e.path();
            let bytes = fs::read(&path).ok()?;
            let project: Project = serde_json::from_slice(&bytes).ok()?;
            let meta = e.metadata().ok()?;
            Some(AutosaveEntry {
                path: path.to_string_lossy().to_string(),
                project_name: project.name,
                project_id: project.id,
                modified_at: project.modified_at,
                size: meta.len(),
            })
        })
        .collect();
    entries.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    entries.truncate(20);
    entries
}

pub fn delete_autosave(dir: &Path, path: &str) -> Result<(), String> {
    let candidate = PathBuf::from(path);
    let canonical_dir = dir
        .canonicalize()
        .map_err(|e| format!("Autosave folder unavailable: {e}"))?;
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("Autosave file unavailable: {e}"))?;
    if !canonical.starts_with(&canonical_dir) {
        return Err("Refusing to delete a file outside the autosave folder.".into());
    }
    fs::remove_file(&canonical).map_err(|e| format!("Cannot delete autosave: {e}"))
}

#[allow(dead_code)]
fn _assert_clip_type(_: &AudioClip) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{Track, TrackKind};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "studio-clone-test-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trip_preserves_project_and_stable_ids() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("Song.cproj");
        let mut project = Project::new("Round Trip");
        let mut track = Track::new(TrackKind::Audio, "Lead", "#4f8fce");
        track.id = "track-stable-1".into();
        track.clips.push(AudioClip {
            id: "clip-stable-1".into(),
            name: "Take".into(),
            duration_ticks: 960,
            ..Default::default()
        });
        project.tracks.push(track);

        let saved = save_project(&path, &project).unwrap();
        assert!(path.exists());
        let loaded = load_project(&path).unwrap();
        assert_eq!(loaded.project.id, project.id);
        assert_eq!(loaded.project.tracks[0].id, "track-stable-1");
        assert_eq!(loaded.project.tracks[0].clips[0].id, "clip-stable-1");
        assert_eq!(saved.path, path.to_string_lossy());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn external_media_is_consolidated_and_referenced_relatively() {
        let dir = temp_dir("media");
        let source_dir = dir.join("external");
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("loop.wav");
        fs::write(&source, b"RIFF-not-real-but-copyable").unwrap();
        let project_path = dir.join("Song.cproj");
        let mut project = Project::new("Media");
        let mut track = Track::new(TrackKind::Audio, "Audio", "#4f8fce");
        track.clips.push(AudioClip {
            id: "c1".into(),
            media_path: source.to_string_lossy().to_string(),
            ..Default::default()
        });
        project.tracks.push(track);

        let result = save_project(&project_path, &project).unwrap();
        assert_eq!(result.copied_files.len(), 1);
        let text = fs::read_to_string(&project_path).unwrap();
        let stored: Project = serde_json::from_str(&text).unwrap();
        assert!(stored.tracks[0].clips[0].media_path.contains("Song.media"));
        assert!(Path::new(&stored.tracks[0].clips[0].media_path).is_relative());
        let loaded = load_project(&project_path).unwrap();
        assert!(Path::new(&loaded.project.tracks[0].clips[0].media_path).is_absolute());
        assert!(loaded.missing_media.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn future_format_is_rejected() {
        let dir = temp_dir("future");
        let path = dir.join("Future.cproj");
        let mut project = Project::new("Future");
        project.format_version = FORMAT_VERSION + 1;
        fs::write(&path, serde_json::to_vec(&project).unwrap()).unwrap();
        let err = load_project(&path).unwrap_err();
        assert!(err.contains("newer version"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn autosave_is_listed_and_pruned() {
        let dir = temp_dir("autosave");
        let project = Project::new("Auto");
        let path = autosave_project(&dir, &project).unwrap();
        assert!(Path::new(&path).exists());
        let list = list_autosaves(&dir);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].project_name, "Auto");
        delete_autosave(&dir, &path).unwrap();
        assert!(list_autosaves(&dir).is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_media_is_reported() {
        let dir = temp_dir("missing");
        let path = dir.join("Missing.cproj");
        let mut project = Project::new("Missing");
        let mut track = Track::new(TrackKind::Audio, "Audio", "#4f8fce");
        track.clips.push(AudioClip {
            id: "c1".into(),
            media_path: "gone.wav".into(),
            ..Default::default()
        });
        project.tracks.push(track);
        fs::write(&path, serde_json::to_vec(&project).unwrap()).unwrap();
        let opened = load_project(&path).unwrap();
        assert_eq!(opened.missing_media.len(), 1);
        let _ = fs::remove_dir_all(dir);
    }
}
