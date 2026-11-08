const LOCAL_FILE: u32 = 0x0403_4b50;
const CENTRAL_FILE: u32 = 0x0201_4b50;
const END_OF_DIRECTORY: u32 = 0x0605_4b50;
const UTF8_FLAG: u16 = 1 << 11;
const VERSION: u16 = 20;
const DOS_DATE: u16 = 33;

const CRC32_TABLE: [u32; 256] = {
    let mut table = [0; 256];
    let mut byte = 0;
    while byte < 256 {
        let mut value = byte as u32;
        let mut bit = 0;
        while bit < 8 {
            value = (value >> 1) ^ if value & 1 == 0 { 0 } else { 0xedb8_8320 };
            bit += 1;
        }
        table[byte] = value;
        byte += 1;
    }
    table
};

fn crc32(bytes: &[u8]) -> u32 {
    !bytes.iter().fold(u32::MAX, |crc, byte| {
        (crc >> 8) ^ CRC32_TABLE[((crc as u8) ^ byte) as usize]
    })
}

fn words(out: &mut Vec<u8>, values: &[u16]) {
    for word in values {
        out.extend_from_slice(&word.to_le_bytes());
    }
}

fn longs(out: &mut Vec<u8>, values: &[u32]) {
    for word in values {
        out.extend_from_slice(&word.to_le_bytes());
    }
}

// The caller bounds the paths, file count and byte sizes below all ZIP32 limits.
// Store-only entries keep offsets, CRCs and sizes deterministic without a compression worker.
pub(super) fn archive(files: Vec<(String, Vec<u8>)>) -> Vec<u8> {
    let entries = files.len() as u16;
    let mut output = Vec::with_capacity(
        files
            .iter()
            .map(|(path, bytes)| path.len() * 2 + bytes.len() + 76)
            .sum::<usize>()
            + 22,
    );
    let mut central = Vec::new();
    for (path, bytes) in files {
        let name = path.as_bytes();
        let offset = output.len() as u32;
        let size = bytes.len() as u32;
        let checksum = crc32(&bytes);
        longs(&mut output, &[LOCAL_FILE]);
        words(&mut output, &[VERSION, UTF8_FLAG, 0, 0, DOS_DATE]);
        longs(&mut output, &[checksum, size, size]);
        words(&mut output, &[name.len() as u16, 0]);
        output.extend_from_slice(name);
        output.extend_from_slice(&bytes);

        longs(&mut central, &[CENTRAL_FILE]);
        words(&mut central, &[VERSION, VERSION, UTF8_FLAG, 0, 0, DOS_DATE]);
        longs(&mut central, &[checksum, size, size]);
        words(&mut central, &[name.len() as u16, 0, 0, 0, 0]);
        longs(&mut central, &[0, offset]);
        central.extend_from_slice(name);
    }
    let central_offset = output.len() as u32;
    let central_size = central.len() as u32;
    output.extend(central);
    longs(&mut output, &[END_OF_DIRECTORY]);
    words(&mut output, &[0, 0, entries, entries]);
    longs(&mut output, &[central_size, central_offset]);
    words(&mut output, &[0]);
    output
}

#[cfg(test)]
mod tests {
    #[test]
    fn standard_crc32_check_value() {
        assert_eq!(super::crc32(b"123456789"), 0xcbf4_3926);
    }
}
