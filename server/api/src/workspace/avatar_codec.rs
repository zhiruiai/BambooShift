use base64::{Engine, engine::general_purpose::STANDARD};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits, imageops::FilterType};
use serde::{Deserialize, Serialize};
use std::io::Cursor;

pub const UPLOAD_BYTES: usize = 25 * 1024 * 1024;
pub const PREVIEW_BYTES: usize = 2 * 1024 * 1024;
pub const ASSET_BYTES: usize = 512 * 1024;
const MAX_PIXELS: u64 = 40_000_000;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Crop {
    pub left: u32,
    pub top: u32,
    pub size: u32,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub op: String,
    pub bytes: String,
    pub crop: Option<Crop>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Output {
    pub width: u32,
    pub height: u32,
    pub preview_width: u32,
    pub preview_height: u32,
    pub bytes: String,
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    Invalid,
    TooLarge,
    Crop,
}

pub fn process(input: Request) -> Result<Output, Failure> {
    if input.bytes.len() > UPLOAD_BYTES.div_ceil(3) * 4 {
        return Err(Failure::TooLarge);
    }
    let bytes = STANDARD
        .decode(&input.bytes)
        .map_err(|_| Failure::Invalid)?;
    if bytes.is_empty() || bytes.len() >= UPLOAD_BYTES {
        return Err(Failure::TooLarge);
    }
    let format = image::guess_format(&bytes).map_err(|_| Failure::Invalid)?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) || animated(&bytes, format)?
    {
        return Err(Failure::Invalid);
    }
    let mut limits = Limits::default();
    limits.max_alloc = Some(384 * 1024 * 1024);
    limits.max_image_width = Some(MAX_PIXELS as u32);
    limits.max_image_height = Some(MAX_PIXELS as u32);
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| Failure::Invalid)?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(Failure::TooLarge);
    }
    let orientation = decoder.orientation().map_err(|_| Failure::Invalid)?;
    let mut decoded = DynamicImage::from_decoder(decoder).map_err(|_| Failure::Invalid)?;
    decoded.apply_orientation(orientation);
    let (width, height) = (decoded.width(), decoded.height());
    if input.op == "portable" {
        if input.crop.is_some()
            || format != ImageFormat::WebP
            || width != 512
            || height != 512
            || bytes.len() > ASSET_BYTES
        {
            return Err(Failure::Invalid);
        }
        // A normalized asset is decoded for validation but never recompressed on each copy.
        let mut at = 12_usize;
        let mut metadata = false;
        while at + 8 <= bytes.len() {
            metadata |= matches!(&bytes[at..at + 4], b"EXIF" | b"XMP " | b"ICCP");
            let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
            at = at
                .checked_add(8 + size + (size & 1))
                .ok_or(Failure::Invalid)?;
        }
        if at != bytes.len() {
            return Err(Failure::Invalid);
        }
        if !metadata {
            return Ok(Output {
                width,
                height,
                preview_width: 512,
                preview_height: 512,
                bytes: STANDARD.encode(bytes),
            });
        }
    }
    let (output, quality, maximum) = match input.op.as_str() {
        "source" if input.crop.is_none() => {
            let preview = if width > 1600 || height > 1600 {
                decoded.resize(1600, 1600, FilterType::Lanczos3)
            } else {
                decoded
            };
            (preview, 80.0, PREVIEW_BYTES)
        }
        "portable" => (decoded, 85.0, ASSET_BYTES),
        "crop" => {
            let crop = input.crop.ok_or(Failure::Crop)?;
            if crop.size == 0
                || crop.size > width
                || crop.size > height
                || crop.left > width - crop.size
                || crop.top > height - crop.size
            {
                return Err(Failure::Crop);
            }
            (
                decoded
                    .crop_imm(crop.left, crop.top, crop.size, crop.size)
                    .resize_exact(512, 512, FilterType::Lanczos3),
                85.0,
                ASSET_BYTES,
            )
        }
        _ => return Err(Failure::Invalid),
    };
    let rgba = output.to_rgba8();
    let mut config = webp::WebPConfig::new().map_err(|_| Failure::Invalid)?;
    config.quality = quality;
    config.alpha_quality = 100;
    config.method = 4;
    config.thread_level = 0;
    let encoded = webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height())
        .encode_advanced(&config)
        .map_err(|_| Failure::Invalid)?;
    if encoded.len() > maximum {
        return Err(Failure::TooLarge);
    }
    Ok(Output {
        width,
        height,
        preview_width: output.width(),
        preview_height: output.height(),
        bytes: STANDARD.encode(&*encoded),
    })
}

fn animated(bytes: &[u8], format: ImageFormat) -> Result<bool, Failure> {
    match format {
        ImageFormat::Png => {
            let mut at = 8_usize;
            while at + 12 <= bytes.len() {
                let size = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
                let kind = &bytes[at + 4..at + 8];
                if matches!(kind, b"acTL" | b"fcTL" | b"fdAT") {
                    return Ok(true);
                }
                at = at.checked_add(size + 12).ok_or(Failure::Invalid)?;
                if at > bytes.len() {
                    return Err(Failure::Invalid);
                }
                if kind == b"IEND" {
                    return Ok(false);
                }
            }
            Err(Failure::Invalid)
        }
        ImageFormat::WebP => {
            let mut at = 12_usize;
            while at + 8 <= bytes.len() {
                let kind = &bytes[at..at + 4];
                let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
                if matches!(kind, b"ANIM" | b"ANMF")
                    || (kind == b"VP8X"
                        && size > 0
                        && bytes.get(at + 8).is_some_and(|v| v & 2 != 0))
                {
                    return Ok(true);
                }
                at = at
                    .checked_add(8 + size + (size & 1))
                    .ok_or(Failure::Invalid)?;
                if at > bytes.len() {
                    return Err(Failure::Invalid);
                }
            }
            if at != bytes.len() {
                return Err(Failure::Invalid);
            }
            Ok(false)
        }
        _ => Ok(false),
    }
}
