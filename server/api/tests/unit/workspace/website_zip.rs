#[test]
fn standard_crc32_check_value() {
    assert_eq!(super::crc32(b"123456789"), 0xcbf4_3926);
}
