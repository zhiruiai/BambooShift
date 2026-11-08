use crate::error::Result;

const HEADER_BYTES: usize = 44;
const SOURCE_RATE: usize = 22_050;
const TARGET_RATE: usize = 16_000;
const MAX_SECONDS: usize = 60;
pub(super) const MAX_BYTES: usize = HEADER_BYTES + SOURCE_RATE * 2 * MAX_SECONDS;

pub(super) fn has_voice(catalog: &str, voice: &str) -> bool {
    catalog.lines().any(|line| {
        let mut fields = line.split_whitespace();
        fields
            .next()
            .is_some_and(|priority| priority.bytes().all(|byte| byte.is_ascii_digit()))
            && fields.next() == Some(voice)
    })
}

fn word(bytes: &[u8], offset: usize) -> usize {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize
}

pub(super) fn normalize(wave: &[u8]) -> Result<Vec<u8>> {
    let invalid = super::invalid_audio;
    let header = wave.get(..HEADER_BYTES).ok_or_else(invalid)?;
    let pcm = &wave[HEADER_BYTES..];
    let rate = word(header, 24);
    if wave.len() > MAX_BYTES
        || &header[..4] != b"RIFF"
        || word(header, 4) != wave.len() - 8
        || &header[8..24] != b"WAVEfmt \x10\0\0\0\x01\0\x01\0"
        || !matches!(rate, SOURCE_RATE | TARGET_RATE)
        || word(header, 28) != rate * 2
        || &header[32..40] != b"\x02\0\x10\0data"
        || word(header, 40) != pcm.len()
        || pcm.len() % 2 != 0
        || pcm.is_empty()
        || pcm.len() > rate * MAX_SECONDS * 2
    {
        return Err(invalid());
    }
    if rate == TARGET_RATE {
        return Ok(wave.to_vec());
    }

    let frames = pcm.len() / 2 * TARGET_RATE / rate;
    let mut normalized = Vec::with_capacity(HEADER_BYTES + frames * 2);
    normalized.extend_from_slice(header);
    normalized[4..8].copy_from_slice(&(36 + frames as u32 * 2).to_le_bytes());
    normalized[24..28].copy_from_slice(&(TARGET_RATE as u32).to_le_bytes());
    normalized[28..32].copy_from_slice(&(TARGET_RATE as u32 * 2).to_le_bytes());
    normalized[40..44].copy_from_slice(&(frames as u32 * 2).to_le_bytes());
    // Average source samples over each output frame to attenuate downsampling artifacts.
    for frame in 0..frames {
        let mut start = frame * rate;
        let end = start + rate;
        let mut sum = 0i64;
        while start < end {
            let source = start / TARGET_RATE;
            let next = end.min((source + 1) * TARGET_RATE);
            let offset = source * 2;
            let sample = i16::from_le_bytes([pcm[offset], pcm[offset + 1]]) as i64;
            sum += sample * (next - start) as i64;
            start = next;
        }
        normalized.extend_from_slice(&((sum / rate as i64) as i16).to_le_bytes());
    }
    Ok(normalized)
}
