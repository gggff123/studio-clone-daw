use crate::audio::engine::{LiveEvent, LiveEventKind};
use crossbeam_channel::Sender;
use midir::{MidiInput, MidiInputConnection, MidiOutput};
use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiDeviceList {
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiConnectionStatus {
    pub connected: bool,
    pub device: Option<String>,
    pub target_track_id: Option<String>,
    pub error: Option<String>,
}

pub struct MidiInputManager {
    connection: Option<MidiInputConnection<()>>,
    target_track_id: Arc<Mutex<String>>,
    device_name: Option<String>,
    error: Option<String>,
}

impl Default for MidiInputManager {
    fn default() -> Self {
        Self {
            connection: None,
            target_track_id: Arc::new(Mutex::new(String::new())),
            device_name: None,
            error: None,
        }
    }
}

pub fn list_midi_devices() -> MidiDeviceList {
    let mut error = None;
    let inputs = match MidiInput::new("Studio Clone Device Scan") {
        Ok(input) => input
            .ports()
            .iter()
            .filter_map(|port| input.port_name(port).ok())
            .collect(),
        Err(err) => {
            error = Some(format!("MIDI input enumeration failed: {err}"));
            Vec::new()
        }
    };
    let outputs = match MidiOutput::new("Studio Clone Device Scan") {
        Ok(output) => output
            .ports()
            .iter()
            .filter_map(|port| output.port_name(port).ok())
            .collect(),
        Err(err) => {
            if error.is_none() {
                error = Some(format!("MIDI output enumeration failed: {err}"));
            }
            Vec::new()
        }
    };
    MidiDeviceList {
        inputs,
        outputs,
        error,
    }
}

impl MidiInputManager {
    pub fn connect(
        &mut self,
        device_name: &str,
        target_track_id: &str,
        sender: Sender<LiveEvent>,
    ) -> Result<(), String> {
        self.disconnect();
        let input = MidiInput::new("Studio Clone MIDI Input")
            .map_err(|e| format!("Cannot initialize MIDI input: {e}"))?;
        let ports = input.ports();
        let port = ports
            .iter()
            .find(|port| input.port_name(port).ok().as_deref() == Some(device_name))
            .ok_or_else(|| format!("MIDI input '{device_name}' is not available."))?;
        if let Ok(mut target) = self.target_track_id.lock() {
            *target = target_track_id.to_string();
        }
        let target = self.target_track_id.clone();
        let connection = input
            .connect(
                port,
                "Studio Clone Input",
                move |_timestamp, message, _| {
                    let Some(kind) = parse_midi_message(message) else {
                        return;
                    };
                    let track_id = target
                        .lock()
                        .map(|t| t.clone())
                        .unwrap_or_default();
                    if track_id.is_empty() {
                        return;
                    }
                    let _ = sender.try_send(LiveEvent {
                        track_id,
                        kind,
                    });
                },
                (),
            )
            .map_err(|e| format!("Cannot connect MIDI input: {e}"))?;
        self.connection = Some(connection);
        self.device_name = Some(device_name.to_string());
        self.error = None;
        Ok(())
    }

    pub fn set_target(&self, track_id: &str) {
        if let Ok(mut target) = self.target_track_id.lock() {
            *target = track_id.to_string();
        }
    }

    pub fn disconnect(&mut self) {
        self.connection = None;
        self.device_name = None;
    }

    pub fn status(&self) -> MidiConnectionStatus {
        MidiConnectionStatus {
            connected: self.connection.is_some(),
            device: self.device_name.clone(),
            target_track_id: self
                .target_track_id
                .lock()
                .ok()
                .map(|t| t.clone())
                .filter(|t| !t.is_empty()),
            error: self.error.clone(),
        }
    }
}

pub fn parse_midi_message(message: &[u8]) -> Option<LiveEventKind> {
    let status = *message.first()?;
    let kind = status & 0xF0;
    match kind {
        0x90 => {
            let note = *message.get(1)?;
            let velocity = *message.get(2)?;
            if velocity == 0 {
                Some(LiveEventKind::NoteOff { note })
            } else {
                Some(LiveEventKind::NoteOn { note, velocity })
            }
        }
        0x80 => Some(LiveEventKind::NoteOff {
            note: *message.get(1)?,
        }),
        0xB0 => {
            let controller = *message.get(1)?;
            let value = *message.get(2)?;
            if controller == 64 {
                Some(LiveEventKind::Sustain(value >= 64))
            } else {
                None
            }
        }
        0xE0 => {
            let lsb = *message.get(1)? as i32;
            let msb = *message.get(2)? as i32;
            let value = (msb << 7) | lsb;
            Some(LiveEventKind::PitchBend(
                ((value - 8192) as f32 / 8192.0).clamp(-1.0, 1.0),
            ))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_note_messages() {
        match parse_midi_message(&[0x90, 60, 100]).unwrap() {
            LiveEventKind::NoteOn { note, velocity } => {
                assert_eq!(note, 60);
                assert_eq!(velocity, 100);
            }
            _ => panic!("expected note on"),
        }
        assert!(matches!(
            parse_midi_message(&[0x90, 60, 0]).unwrap(),
            LiveEventKind::NoteOff { note: 60 }
        ));
        assert!(matches!(
            parse_midi_message(&[0x80, 62, 0]).unwrap(),
            LiveEventKind::NoteOff { note: 62 }
        ));
    }

    #[test]
    fn parses_cc64_and_pitch_bend() {
        assert!(matches!(
            parse_midi_message(&[0xB0, 64, 127]).unwrap(),
            LiveEventKind::Sustain(true)
        ));
        assert!(matches!(
            parse_midi_message(&[0xB0, 1, 50]),
            None
        ));
        match parse_midi_message(&[0xE0, 0x00, 0x40]).unwrap() {
            LiveEventKind::PitchBend(value) => assert!(value.abs() < 0.001),
            _ => panic!("expected pitch bend"),
        }
    }

    #[test]
    fn ignores_truncated_or_irrelevant_messages() {
        assert!(parse_midi_message(&[]).is_none());
        assert!(parse_midi_message(&[0x90]).is_none());
        assert!(parse_midi_message(&[0xF8]).is_none());
    }
}
