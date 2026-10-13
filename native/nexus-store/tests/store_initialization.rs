use nexus_contracts::KernelErrorCode;
use nexus_store::Store;

fn open_error(path: &std::path::Path) -> KernelErrorCode {
    Store::open(path)
        .err()
        .expect("store must fail closed")
        .code
}

#[test]
fn issuance_key_is_32_random_bytes_and_persists() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let mut store = Store::open(&path).unwrap();
    let key = store.issuance_key_hex().unwrap();
    assert_eq!(key.len(), 64);
    assert!(key
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    assert_eq!(hex::decode(&key).unwrap().len(), 32);
    assert_eq!(store.issuance_key_hex().unwrap(), key);
    drop(store);
    assert_eq!(Store::open(&path).unwrap().issuance_key_hex().unwrap(), key);

    let other_key = Store::open(&dir.path().join("other.db"))
        .unwrap()
        .issuance_key_hex()
        .unwrap();
    assert_ne!(key, other_key, "independent stores use independent entropy");
}

#[test]
fn non_database_is_corrupt_and_is_not_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let garbage = b"this is not a sqlite database at all";
    std::fs::write(&path, garbage).unwrap();
    assert_eq!(open_error(&path), KernelErrorCode::StoreCorrupt);
    assert_eq!(std::fs::read(&path).unwrap(), garbage);
}

#[test]
fn malformed_sqlite_page_is_corrupt() {
    use std::io::{Seek, SeekFrom, Write};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    drop(Store::open(&path).unwrap());
    let mut file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    // Keep the SQLite header intact, but invalidate the schema B-tree page type.
    file.seek(SeekFrom::Start(100)).unwrap();
    file.write_all(&[0xff]).unwrap();
    drop(file);
    let conn = rusqlite::Connection::open(&path).unwrap();
    let err = conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap_err();
    assert_eq!(
        err.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseCorrupt)
    );
    drop(conn);
    assert_eq!(open_error(&path), KernelErrorCode::StoreCorrupt);
}

#[test]
fn existing_directory_is_operational_error() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(open_error(dir.path()), KernelErrorCode::StoreError);
}

#[test]
fn locked_database_is_operational_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE lock_test (id INTEGER); BEGIN EXCLUSIVE;")
        .unwrap();
    assert_eq!(open_error(&path), KernelErrorCode::StoreError);
    conn.execute_batch("ROLLBACK;").unwrap();
    assert!(Store::open(&path).is_ok());
}

#[test]
fn incompatible_schema_remains_incompatible() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    drop(Store::open(&path).unwrap());
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("UPDATE schema_version SET version = 99", [])
        .unwrap();
    drop(conn);
    assert_eq!(open_error(&path), KernelErrorCode::StoreIncompatible);
}

#[cfg(unix)]
#[test]
fn permission_denied_is_operational_error() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    drop(Store::open(&path).unwrap());
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    let code = open_error(&path);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(code, KernelErrorCode::StoreError);
}
