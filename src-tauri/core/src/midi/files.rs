use crate::project::{MidiNote, MidiPart, Project};
use midly::num::{u15, u24, u28, u4, u7};
use midly::{
    Format, Header, MetaMessage, MidiMessage, Smf, Timing, TrackEvent, TrackEventKind,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiImportResult {
    pub name: String,
    pub parts: Vec<MidiPart>,
    pub tempo: Option<f64>,
    pub ppq: u32,
    pub duration_ticks: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiExportResult {
    pub path: String,
    pub tracks_written: usize,
    pub notes_written: usize,
}

fn u15_for(ppq: u32) -> u15 {
    u15::try_from(ppq.min(32_767) as u16).unwrap_or_else(|| u15::new(960))
}

pub fn import_midi_file(path: &Path, target_ppq: u32) -> Result<MidiImportResult, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read MIDI file: {e}"))?;
    let smf = Smf::parse(&bytes).map_err(|e| format!("Invalid Standard MIDI File: {e}"))?;
    let source_ppq = match smf.header.timing {
        Timing::Metrical(value) => value.as_int() as u32,
        Timing::Timecode(_, _) => {
            return Err("SMPTE-timecode MIDI files are not supported yet.".into())
        }
    }
    .max(1);
    let scale = target_ppq.max(1) as f64 / source_ppq as f64;
    let mut parts = Vec::new();
    let mut tempo = None;
    let mut warnings = Vec::new();
    let mut duration_ticks = 0u64;

    for (track_index, track) in smf.tracks.iter().enumerate() {
        let mut abs_tick = 0u64;
        let mut name: Option<String> = None;
        let mut open: HashMap<(u8, u8), Vec<(u64, u8)>> = HashMap::new();
        let mut notes = Vec::new();
        for event in track {
            abs_tick = abs_tick.saturating_add(event.delta.as_int() as u64);
            match event.kind {
                TrackEventKind::Meta(meta) => match meta {
                    MetaMessage::TrackName(bytes) => {
                        name = Some(String::from_utf8_lossy(bytes).trim().to_string());
                    }
                    MetaMessage::Tempo(value) => {
                        if tempo.is_none() {
                            let micros = value.as_int();
                            if micros > 0 {
                                tempo = Some(60_000_000.0 / micros as f64);
                            }
                        }
                    }
                    _ => {}
                },
                TrackEventKind::Midi { channel, message } => {
                    let channel = channel.as_int();
                    match message {
                        MidiMessage::NoteOn { key, vel } => {
                            let note = key.as_int();
                            if vel.as_int() == 0 {
                                close_note(
                                    &mut open,
                                    &mut notes,
                                    channel,
                                    note,
                                    abs_tick,
                                    scale,
                                );
                            } else {
                                open.entry((channel, note)).or_default().push((
                                    (abs_tick as f64 * scale).round() as u64,
                                    vel.as_int(),
                                ));
                            }
                        }
                        MidiMessage::NoteOff { key, .. } => {
                            close_note(
                                &mut open,
                                &mut notes,
                                channel,
                                key.as_int(),
                                abs_tick,
                                scale,
                            );
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        let end_tick = (abs_tick as f64 * scale).round() as u64;
        for ((channel, note), stack) in open.iter_mut() {
            while let Some((start, velocity)) = stack.pop() {
                notes.push(MidiNote {
                    id: uuid::Uuid::new_v4().to_string(),
                    pitch: *note,
                    start_ticks: start,
                    duration_ticks: end_tick.saturating_sub(start).max(1),
                    velocity: velocity.clamp(1, 127),
                    channel: *channel,
                });
            }
        }
        if notes.is_empty() {
            continue;
        }
        notes.sort_by_key(|n| (n.start_ticks, n.pitch));
        let part_end = notes
            .iter()
            .map(|n| n.start_ticks + n.duration_ticks)
            .max()
            .unwrap_or(0);
        duration_ticks = duration_ticks.max(part_end);
        parts.push(MidiPart {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.unwrap_or_else(|| format!("MIDI Track {}", track_index + 1)),
            start_ticks: 0,
            duration_ticks: part_end.max(target_ppq.max(1) as u64),
            color: "#6f86b8".into(),
            notes,
        });
    }

    if parts.is_empty() {
        return Err("The MIDI file contains no notes.".into());
    }
    if tempo.is_none() {
        warnings.push("No tempo event found; the project tempo will be used.".into());
    }
    let name = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "MIDI Import".into());

    Ok(MidiImportResult {
        name,
        parts,
        tempo,
        ppq: target_ppq,
        duration_ticks,
        warnings,
    })
}

fn close_note(
    open: &mut HashMap<(u8, u8), Vec<(u64, u8)>>,
    notes: &mut Vec<MidiNote>,
    channel: u8,
    note: u8,
    abs_tick: u64,
    scale: f64,
) {
    let end = (abs_tick as f64 * scale).round() as u64;
    if let Some(stack) = open.get_mut(&(channel, note)) {
        if let Some((start, velocity)) = stack.pop() {
            notes.push(MidiNote {
                id: uuid::Uuid::new_v4().to_string(),
                pitch: note,
                start_ticks: start,
                duration_ticks: end.saturating_sub(start).max(1),
                velocity: velocity.clamp(1, 127),
                channel,
            });
        }
    }
}

pub fn export_midi_file(project: &Project, path: &Path) -> Result<MidiExportResult, String> {
    let ppq = project.ppq.clamp(1, 32_767);
    let tempo_us = (60_000_000.0 / project.tempo.clamp(20.0, 300.0)).round() as u32;
    let mut tracks: Vec<Vec<TrackEvent>> = Vec::new();
    let mut tracks_written = 0usize;
    let mut notes_written = 0usize;

    // Tempo / time-signature conductor track.
    let mut conductor = Vec::new();
    conductor.push(TrackEvent {
        delta: u28::new(0),
        kind: TrackEventKind::Meta(MetaMessage::TrackName(project.name.as_bytes())),
    });
    conductor.push(TrackEvent {
        delta: u28::new(0),
        kind: TrackEventKind::Meta(MetaMessage::Tempo(u24::new(tempo_us.min(0xFF_FFFF)))),
    });
    let denominator = (project.time_signature.denominator.max(1) as f64).log2() as u8;
    conductor.push(TrackEvent {
        delta: u28::new(0),
        kind: TrackEventKind::Meta(MetaMessage::TimeSignature(
            project.time_signature.numerator.min(255) as u8,
            denominator,
            24,
            8,
        )),
    });
    conductor.push(TrackEvent {
        delta: u28::new(0),
        kind: TrackEventKind::Meta(MetaMessage::EndOfTrack),
    });
    tracks.push(conductor);

    for track in &project.tracks {
        if !matches!(
            track.kind,
            crate::project::TrackKind::Instrument | crate::project::TrackKind::Midi
        ) {
            continue;
        }
        let mut events: Vec<(u64, u8, TrackEventKind)> = Vec::new();
        for part in &track.parts {
            for note in &part.notes {
                let start = part.start_ticks.saturating_add(note.start_ticks);
                let end = start.saturating_add(note.duration_ticks.max(1));
                let channel = u4::new(note.channel.min(15));
                events.push((
                    start,
                    1,
                    TrackEventKind::Midi {
                        channel,
                        message: MidiMessage::NoteOn {
                            key: u7::new(note.pitch.min(127)),
                            vel: u7::new(note.velocity.clamp(1, 127)),
                        },
                    },
                ));
                events.push((
                    end,
                    0,
                    TrackEventKind::Midi {
                        channel,
                        message: MidiMessage::NoteOff {
                            key: u7::new(note.pitch.min(127)),
                            vel: u7::new(0),
                        },
                    },
                ));
                notes_written += 1;
            }
        }
        if events.is_empty() {
            continue;
        }
        events.sort_by_key(|(tick, order, _)| (*tick, *order));
        let mut smf_track = Vec::new();
        smf_track.push(TrackEvent {
            delta: u28::new(0),
            kind: TrackEventKind::Meta(MetaMessage::TrackName(track.name.as_bytes())),
        });
        let mut last = 0u64;
        for (tick, _, kind) in events {
            let delta = u28::try_from(tick.saturating_sub(last) as u32)
                .unwrap_or_else(|| u28::new(0));
            smf_track.push(TrackEvent { delta, kind });
            last = tick;
        }
        smf_track.push(TrackEvent {
            delta: u28::new(0),
            kind: TrackEventKind::Meta(MetaMessage::EndOfTrack),
        });
        tracks.push(smf_track);
        tracks_written += 1;
    }

    if notes_written == 0 {
        return Err("There are no MIDI notes to export.".into());
    }

    let smf = Smf {
        header: Header::new(Format::Parallel, Timing::Metrical(u15_for(ppq))),
        tracks,
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create MIDI export folder: {e}"))?;
    }
    let temp = path.with_file_name(format!(
        ".{}.{}.tmp.mid",
        path.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "export".into()),
        uuid::Uuid::new_v4()
    ));
    {
        let mut file = std::fs::File::create(&temp)
            .map_err(|e| format!("Cannot create MIDI file: {e}"))?;
        smf.write_std(&mut file)
            .map_err(|e| format!("Cannot write MIDI data: {e}"))?;
    }
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Cannot finalize MIDI file: {e}")
    })?;

    Ok(MidiExportResult {
        path: path.to_string_lossy().to_string(),
        tracks_written,
        notes_written,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{MidiNote, MidiPart, Track, TrackKind};

    fn write_fixture(path: &Path) {
        let mut track = Vec::new();
        track.push(TrackEvent {
            delta: u28::new(0),
            kind: TrackEventKind::Meta(MetaMessage::TrackName(b"Lead")),
        });
        track.push(TrackEvent {
            delta: u28::new(0),
            kind: TrackEventKind::Meta(MetaMessage::Tempo(u24::new(500_000))),
        });
        track.push(TrackEvent {
            delta: u28::new(0),
            kind: TrackEventKind::Midi {
                channel: u4::new(0),
                message: MidiMessage::NoteOn {
                    key: u7::new(60),
                    vel: u7::new(100),
                },
            },
        });
        track.push(TrackEvent {
            delta: u28::new(480),
            kind: TrackEventKind::Midi {
                channel: u4::new(0),
                message: MidiMessage::NoteOff {
                    key: u7::new(60),
                    vel: u7::new(0),
                },
            },
        });
        track.push(TrackEvent {
            delta: u28::new(0),
            kind: TrackEventKind::Meta(MetaMessage::EndOfTrack),
        });
        let smf = Smf {
            header: Header::new(Format::SingleTrack, Timing::Metrical(u15::new(960))),
            tracks: vec![track],
        };
        smf.save(path).unwrap();
    }

    #[test]
    fn imports_notes_and_tempo() {
        let dir = std::env::temp_dir().join(format!("studio-midi-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fixture.mid");
        write_fixture(&path);
        let result = import_midi_file(&path, 960).unwrap();
        assert_eq!(result.parts.len(), 1);
        assert_eq!(result.parts[0].notes.len(), 1);
        assert_eq!(result.parts[0].notes[0].pitch, 60);
        assert_eq!(result.parts[0].notes[0].duration_ticks, 480);
        assert!((result.tempo.unwrap() - 120.0).abs() < 0.01);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn round_trip_export_and_import() {
        let dir = std::env::temp_dir().join(format!("studio-midi-rt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("export.mid");
        let mut project = Project::new("MIDI Round Trip");
        let mut track = Track::new(TrackKind::Instrument, "Synth", "#4f8fce");
        track.parts.push(MidiPart {
            id: "part".into(),
            name: "Part".into(),
            notes: vec![
                MidiNote {
                    id: "a".into(),
                    pitch: 64,
                    start_ticks: 0,
                    duration_ticks: 480,
                    velocity: 90,
                    channel: 0,
                },
                MidiNote {
                    id: "b".into(),
                    pitch: 67,
                    start_ticks: 480,
                    duration_ticks: 960,
                    velocity: 110,
                    channel: 0,
                },
            ],
            duration_ticks: 1920,
            ..Default::default()
        });
        project.tracks.push(track);
        let result = export_midi_file(&project, &path).unwrap();
        assert_eq!(result.notes_written, 2);
        assert!(path.exists());
        let imported = import_midi_file(&path, 960).unwrap();
        let notes: Vec<_> = imported
            .parts
            .iter()
            .flat_map(|p| p.notes.iter())
            .collect();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].pitch, 64);
        assert_eq!(notes[1].pitch, 67);
        assert_eq!(notes[1].duration_ticks, 960);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn export_without_notes_fails() {
        let project = Project::new("Empty");
        let path = std::env::temp_dir().join("empty-export.mid");
        assert!(export_midi_file(&project, &path).is_err());
    }
}
