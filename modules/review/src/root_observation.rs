//! A checked directory observation, not permanent filesystem identity or approval.
use crate::{Error, Result};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RootObservation {
    pub(crate) dev: u64,
    pub(crate) ino: u64,
}

impl RootObservation {
    pub fn parse(dev: &str, ino: &str) -> Result<Self> {
        fn decimal(value: &str) -> Result<u64> {
            value
                .parse::<u64>()
                .ok()
                .filter(|n| value.len() <= 20 && n.to_string() == value)
                .ok_or_else(|| {
                    Error::new("format", "Use canonical decimal filesystem observations.")
                })
        }
        Ok(Self {
            dev: decimal(dev)?,
            ino: decimal(ino)?,
        })
    }
    pub(crate) fn new(dev: u64, ino: u64) -> Self {
        Self { dev, ino }
    }
}

impl Serialize for RootObservation {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut value = serializer.serialize_struct("RootObservation", 2)?;
        value.serialize_field("dev", &self.dev.to_string())?;
        value.serialize_field("ino", &self.ino.to_string())?;
        value.end()
    }
}
impl<'de> Deserialize<'de> for RootObservation {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            dev: String,
            ino: String,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::parse(&wire.dev, &wire.ino).map_err(serde::de::Error::custom)
    }
}

pub(crate) fn optional<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<RootObservation>, D::Error> {
    RootObservation::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn root_observation_is_exact_decimal_u64_without_duplicate_or_extra_fields() {
        let root: RootObservation =
            serde_json::from_str(r#"{"dev":"0","ino":"18446744073709551615"}"#).unwrap();
        assert_eq!(
            serde_json::to_string(&root).unwrap(),
            r#"{"dev":"0","ino":"18446744073709551615"}"#
        );
        for raw in [
            r#"null"#,
            r#"{"dev":0,"ino":"1"}"#,
            r#"{"dev":"01","ino":"1"}"#,
            r#"{"dev":"+1","ino":"1"}"#,
            r#"{"dev":"1","ino":"18446744073709551616"}"#,
            r#"{"dev":"1","ino":"2","x":0}"#,
            r#"{"dev":"1","dev":"1","ino":"2"}"#,
        ] {
            assert!(
                serde_json::from_str::<RootObservation>(raw).is_err(),
                "{raw}"
            );
        }
    }
}
