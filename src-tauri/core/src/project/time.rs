//! Musical-time conversions. The project uses a constant tempo for this
//! milestone; the API is intentionally isolated so a tempo map can replace the
//! scalar tempo later without touching UI code.

pub fn ticks_to_seconds(ticks: u64, tempo: f64, ppq: u32) -> f64 {
    if ppq == 0 || !tempo.is_finite() || tempo <= 0.0 {
        return 0.0;
    }
    (ticks as f64 / ppq as f64) * (60.0 / tempo)
}

pub fn seconds_to_ticks(seconds: f64, tempo: f64, ppq: u32) -> u64 {
    if ppq == 0 || !tempo.is_finite() || tempo <= 0.0 || !seconds.is_finite() {
        return 0;
    }
    (seconds * tempo / 60.0 * ppq as f64).round().max(0.0) as u64
}

pub fn ticks_to_frames(ticks: u64, tempo: f64, ppq: u32, sample_rate: u32) -> u64 {
    (ticks_to_seconds(ticks, tempo, ppq) * sample_rate as f64).round() as u64
}

pub fn frames_to_ticks(frames: u64, tempo: f64, ppq: u32, sample_rate: u32) -> u64 {
    if sample_rate == 0 {
        return 0;
    }
    seconds_to_ticks(frames as f64 / sample_rate as f64, tempo, ppq)
}

pub fn seconds_to_frames(seconds: f64, sample_rate: u32) -> u64 {
    (seconds.max(0.0) * sample_rate as f64).round() as u64
}

pub fn frames_to_seconds(frames: u64, sample_rate: u32) -> f64 {
    if sample_rate == 0 {
        0.0
    } else {
        frames as f64 / sample_rate as f64
    }
}

pub fn db_to_gain(db: f32) -> f32 {
    if db <= -96.0 {
        0.0
    } else {
        10f32.powf(db / 20.0)
    }
}

pub fn ticks_per_bar(ppq: u32, numerator: u32) -> u64 {
    ppq as u64 * numerator.max(1) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_second_round_trip() {
        let seconds = ticks_to_seconds(960 * 4, 120.0, 960);
        assert!((seconds - 2.0).abs() < 1e-9);
        assert_eq!(seconds_to_ticks(seconds, 120.0, 960), 3840);
    }

    #[test]
    fn frame_conversion_is_tempo_aware() {
        assert_eq!(ticks_to_frames(960, 120.0, 960, 48_000), 24_000);
        assert_eq!(frames_to_ticks(24_000, 120.0, 960, 48_000), 960);
        assert_eq!(ticks_to_seconds(960, 60.0, 960), 1.0);
    }

    #[test]
    fn invalid_values_are_safe() {
        assert_eq!(ticks_to_seconds(100, 0.0, 960), 0.0);
        assert_eq!(ticks_to_seconds(100, 120.0, 0), 0.0);
        assert_eq!(frames_to_ticks(100, 120.0, 960, 0), 0);
    }

    #[test]
    fn gain_conversion() {
        assert!((db_to_gain(0.0) - 1.0).abs() < 1e-6);
        assert!((db_to_gain(-6.0) - 0.501_187).abs() < 1e-4);
        assert_eq!(db_to_gain(-100.0), 0.0);
    }

    #[test]
    fn bar_length_uses_numerator() {
        assert_eq!(ticks_per_bar(960, 4), 3840);
        assert_eq!(ticks_per_bar(960, 3), 2880);
    }
}
