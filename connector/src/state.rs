use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use ed25519_dalek::{SigningKey, VerifyingKey};

use crate::decode_key;

const IDENTITY: &str = "identity";
const TOKEN: &str = "token";
const ALLOWLIST: &str = "allowlist";

pub struct State {
    dir: PathBuf,
    pub identity: SigningKey,
    pub users: Vec<VerifyingKey>,
    pub token: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not access {}", .path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("{} does not hold a valid identity key", .0.display())]
    InvalidIdentity(PathBuf),
    #[error("line {line} of {} is not a valid user key", .path.display())]
    InvalidUser { path: PathBuf, line: usize },
}

impl State {
    pub fn open(dir: PathBuf) -> Result<Self, Error> {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .map_err(io_error(&dir))?;
        let identity = load_identity(&dir.join(IDENTITY))?;
        let users = match read(&dir.join(ALLOWLIST))? {
            Some(allowlist) => parse_allowlist(&dir.join(ALLOWLIST), &allowlist)?,
            None => Vec::new(),
        };
        let token = read(&dir.join(TOKEN))?.map(|token| token.trim().to_owned());
        Ok(Self {
            dir,
            identity,
            users,
            token,
        })
    }

    pub fn allowlist_path(&self) -> PathBuf {
        self.dir.join(ALLOWLIST)
    }

    pub fn allow(&mut self, user: VerifyingKey) -> Result<(), Error> {
        if self.users.contains(&user) {
            return Ok(());
        }
        let path = self.allowlist_path();
        let mut allowlist = read(&path)?.unwrap_or_default();
        if !allowlist.is_empty() && !allowlist.ends_with('\n') {
            allowlist.push('\n');
        }
        allowlist.push_str(&hex::encode(user.as_bytes()));
        allowlist.push('\n');
        replace(&path, allowlist.as_bytes())?;
        self.users.push(user);
        Ok(())
    }

    pub fn save_token(&mut self, token: String) -> Result<(), Error> {
        replace(&self.dir.join(TOKEN), format!("{token}\n").as_bytes())?;
        self.token = Some(token);
        Ok(())
    }
}

fn load_identity(path: &Path) -> Result<SigningKey, Error> {
    let parse = |seed: &str| {
        decode_key(seed)
            .map(|seed| SigningKey::from_bytes(&seed))
            .ok_or_else(|| Error::InvalidIdentity(path.to_owned()))
    };
    if let Some(seed) = read(path)? {
        return parse(&seed);
    }
    let identity = SigningKey::from_bytes(&rand::random());
    let created = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path);
    match created {
        Ok(mut file) => {
            writeln!(file, "{}", hex::encode(identity.to_bytes()))
                .and_then(|()| file.sync_all())
                .map_err(io_error(path))?;
            Ok(identity)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            parse(&read(path)?.unwrap_or_default())
        }
        Err(error) => Err(io_error(path)(error)),
    }
}

fn parse_allowlist(path: &Path, allowlist: &str) -> Result<Vec<VerifyingKey>, Error> {
    allowlist
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let key = line.split_whitespace().next()?;
            (!key.starts_with('#')).then_some((index + 1, key))
        })
        .map(|(line, key)| {
            decode_key(key)
                .and_then(|key| VerifyingKey::from_bytes(&key).ok())
                .ok_or_else(|| Error::InvalidUser {
                    path: path.to_owned(),
                    line,
                })
        })
        .collect()
}

fn read(path: &Path) -> Result<Option<String>, Error> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(path)(error)),
    }
}

fn replace(path: &Path, contents: &[u8]) -> Result<(), Error> {
    let temporary = path.with_extension("tmp");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(io_error(&temporary))?;
    file.write_all(contents)
        .and_then(|()| file.sync_all())
        .map_err(io_error(&temporary))?;
    fs::rename(&temporary, path).map_err(io_error(path))
}

fn io_error(path: &Path) -> impl FnOnce(io::Error) -> Error {
    let path = path.to_owned();
    |source| Error::Io { path, source }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn temporary_dir() -> PathBuf {
        std::env::temp_dir().join(format!("dbgopher-state-{}", uuid::Uuid::new_v4()))
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn keeps_one_identity_across_opens() {
        let dir = temporary_dir();
        let first = State::open(dir.clone()).unwrap();
        let second = State::open(dir.clone()).unwrap();
        assert_eq!(first.identity.to_bytes(), second.identity.to_bytes());
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join(IDENTITY)), 0o600);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn persists_users_and_the_token_privately() {
        let dir = temporary_dir();
        let user = SigningKey::from_bytes(&[3; 32]).verifying_key();
        let mut state = State::open(dir.clone()).unwrap();
        assert!(state.users.is_empty() && state.token.is_none());
        state.allow(user).unwrap();
        state.allow(user).unwrap();
        state.save_token("secret-token".into()).unwrap();
        let reopened = State::open(dir.clone()).unwrap();
        assert_eq!(reopened.users, vec![user]);
        assert_eq!(reopened.token.as_deref(), Some("secret-token"));
        assert_eq!(mode(&dir.join(ALLOWLIST)), 0o600);
        assert_eq!(mode(&dir.join(TOKEN)), 0o600);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_allowlists_edited_by_hand() {
        let dir = temporary_dir();
        let kept = SigningKey::from_bytes(&[4; 32]).verifying_key();
        let added = SigningKey::from_bytes(&[5; 32]).verifying_key();
        let path = dir.join(ALLOWLIST);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            &path,
            format!("# laptop\n\n{} laptop", hex::encode(kept.as_bytes())),
        )
        .unwrap();
        let mut state = State::open(dir.clone()).unwrap();
        assert_eq!(state.users, vec![kept]);
        state.allow(added).unwrap();
        assert_eq!(State::open(dir.clone()).unwrap().users, vec![kept, added]);
        fs::write(&path, "not-a-key\n").unwrap();
        assert!(matches!(
            State::open(dir.clone()),
            Err(Error::InvalidUser { line: 1, .. })
        ));
        fs::remove_dir_all(dir).unwrap();
    }
}
