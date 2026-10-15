use serde::Serialize;

pub const CONTRACT_VERSION: u32 = 1;

// The adapter supplies this after authenticating its channel; JSON cannot choose authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CallerContext {
    Local,
    LocalCli,
    Review,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationCapability {
    pub action: &'static str,
    pub group: &'static str,
    pub mutates: bool,
}
