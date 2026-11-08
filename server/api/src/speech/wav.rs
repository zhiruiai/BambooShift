use crate::error::{ApiError, Result};
pub const MAX_BYTES: usize = 2 * 1024 * 1024;
fn invalid() -> ApiError {
    ApiError::new(422, "录音格式无效，请重新录制。").with_code("SPEECH_INVALID_AUDIO")
}
fn u16_at(bytes: &[u8], offset: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(
        bytes
            .get(offset..offset + 2)
            .ok_or_else(invalid)?
            .try_into()
            .unwrap(),
    ))
}
fn u32_at(bytes: &[u8], offset: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(
        bytes
            .get(offset..offset + 4)
            .ok_or_else(invalid)?
            .try_into()
            .unwrap(),
    ))
}
/// Keep only validated mono PCM samples; discard all optional recording metadata.
pub fn parse(bytes: &[u8]) -> Result<(Vec<u8>, u64)> {
    if bytes.len() > MAX_BYTES {
        return Err(ApiError::new(413, "录音文件不能超过2MiB。").with_code("SPEECH_TOO_LARGE"));
    }
    if bytes.len() < 44
        || &bytes[..4] != b"RIFF"
        || &bytes[8..12] != b"WAVE"
        || u32_at(bytes, 4)? as usize + 8 != bytes.len()
    {
        return Err(invalid());
    }
    let mut offset = 12;
    let mut format = false;
    let mut pcm = None;
    while offset < bytes.len() {
        if offset + 8 > bytes.len() {
            return Err(invalid());
        }
        let kind = &bytes[offset..offset + 4];
        let size = u32_at(bytes, offset + 4)? as usize;
        let start = offset + 8;
        let end = start.checked_add(size).ok_or_else(invalid)?;
        if end
            .checked_add(size % 2)
            .is_none_or(|end| end > bytes.len())
        {
            return Err(invalid());
        }
        if kind == b"fmt " {
            if format
                || size < 16
                || u16_at(bytes, start)? != 1
                || u16_at(bytes, start + 2)? != 1
                || u32_at(bytes, start + 4)? != 16000
                || u32_at(bytes, start + 8)? != 32000
                || u16_at(bytes, start + 12)? != 2
                || u16_at(bytes, start + 14)? != 16
            {
                return Err(invalid());
            }
            format = true;
        } else if kind == b"data" {
            if pcm.is_some() || size == 0 || size % 2 != 0 {
                return Err(invalid());
            }
            pcm = Some(&bytes[start..end]);
        }
        offset = end + size % 2;
    }
    let pcm = pcm.filter(|_| format).ok_or_else(invalid)?;
    if pcm.len() > 60 * 32000 {
        return Err(ApiError::new(422, "每次录音最多60秒。").with_code("SPEECH_TOO_LONG"));
    }
    if pcm.iter().all(|byte| *byte == 0) {
        return Err(ApiError::new(422, "没有录到声音，请检查麦克风。").with_code("SPEECH_SILENT"));
    }
    let mut output = Vec::with_capacity(44 + pcm.len());
    output.extend_from_slice(b"RIFF");
    output.extend_from_slice(&(36u32 + pcm.len() as u32).to_le_bytes());
    output.extend_from_slice(b"WAVEfmt ");
    output.extend_from_slice(&16u32.to_le_bytes());
    output.extend_from_slice(&1u16.to_le_bytes());
    output.extend_from_slice(&1u16.to_le_bytes());
    output.extend_from_slice(&16000u32.to_le_bytes());
    output.extend_from_slice(&32000u32.to_le_bytes());
    output.extend_from_slice(&2u16.to_le_bytes());
    output.extend_from_slice(&16u16.to_le_bytes());
    output.extend_from_slice(b"data");
    output.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    output.extend_from_slice(pcm);
    Ok((output, pcm.len() as u64 / 32))
}
