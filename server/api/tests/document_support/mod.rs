pub fn pdf(text: &str) -> Vec<u8> {
    let stream = format!("BT /F1 12 Tf 40 700 Td ({text}) Tj ET");
    let objects=["<< /Type /Catalog /Pages 2 0 R >>".to_owned(),"<< /Type /Pages /Kids [4 0 R] /Count 1 >>".to_owned(),"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>".to_owned(),format!("<< /Length {} >>\nstream\n{stream}\nendstream",stream.len())];
    let mut out = "%PDF-1.4\n".to_owned();
    let mut offsets = Vec::new();
    for (index, obj) in objects.iter().enumerate() {
        offsets.push(out.len());
        out += &format!("{} 0 obj\n{obj}\nendobj\n", index + 1);
    }
    let start = out.len();
    out += "xref\n0 6\n0000000000 65535 f \n";
    for offset in offsets {
        out += &format!("{offset:010} 00000 n \n");
    }
    out += &format!("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n");
    out.into_bytes()
}
fn u16_at(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}
fn u32_at(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}
fn crc(bytes: &[u8]) -> u32 {
    let mut value = 0xffffffff_u32;
    for b in bytes {
        value ^= *b as u32;
        for _ in 0..8 {
            value = (value >> 1) ^ if value & 1 != 0 { 0xedb88320 } else { 0 };
        }
    }
    value ^ 0xffffffff
}
pub fn docx(text: &str) -> Vec<u8> {
    let entries=[("[Content_Types].xml",r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#.to_owned()),("_rels/.rels",r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#.to_owned()),("word/document.xml",format!(r#"<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>"#))];
    let mut body = Vec::new();
    let mut directory = Vec::new();
    for (name, content) in &entries {
        let bytes = content.as_bytes();
        let name = name.as_bytes();
        let crc = crc(bytes);
        let mut local = vec![0; 30];
        u32_at(&mut local, 0, 0x04034b50);
        u16_at(&mut local, 4, 20);
        u32_at(&mut local, 14, crc);
        u32_at(&mut local, 18, bytes.len() as u32);
        u32_at(&mut local, 22, bytes.len() as u32);
        u16_at(&mut local, 26, name.len() as u16);
        let mut central = vec![0; 46];
        u32_at(&mut central, 0, 0x02014b50);
        u16_at(&mut central, 4, 20);
        u16_at(&mut central, 6, 20);
        u32_at(&mut central, 16, crc);
        u32_at(&mut central, 20, bytes.len() as u32);
        u32_at(&mut central, 24, bytes.len() as u32);
        u16_at(&mut central, 28, name.len() as u16);
        u32_at(&mut central, 42, body.len() as u32);
        body.extend(local);
        body.extend(name);
        body.extend(bytes);
        directory.extend(central);
        directory.extend(name);
    }
    let mut end = vec![0; 22];
    u32_at(&mut end, 0, 0x06054b50);
    u16_at(&mut end, 8, 3);
    u16_at(&mut end, 10, 3);
    u32_at(&mut end, 12, directory.len() as u32);
    u32_at(&mut end, 16, body.len() as u32);
    body.extend(directory);
    body.extend(end);
    body
}
