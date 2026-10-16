// Synthetic controller/process fixture. Never opens a network connection or reads enrollment.
use std::{env, fs, path::PathBuf, process, thread, time::{Duration, SystemTime, UNIX_EPOCH}};

fn field<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    line.split_once(&format!("\"{name}\":\""))?.1.split('"').next()
}

fn main() {
    let root = env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let state = root.join("controller.jsonl");
    let mode = fs::read_to_string(root.join("mode")).unwrap_or_default();
    let args: Vec<String> = env::args().skip(1).collect();
    let records = fs::read_to_string(&state).unwrap_or_default();
    match args.first().map(String::as_str) {
        Some("list") => {
            if mode == "list-fails" { process::exit(7); }
            if mode == "list-hangs" { thread::sleep(Duration::from_secs(60)); }
            if mode == "list-malformed" { println!("malformed"); return; }
            if mode == "list-oversized" { println!("{}", " ".repeat(300_000)); return; }
            println!("{{\"shares\":[{}]}}", records.lines().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(","));
        }
        Some("delete") => {
            if mode == "delete-fails" { process::exit(8); }
            if mode == "delete-hangs" { thread::sleep(Duration::from_secs(60)); }
            if mode == "delete-no-effect" { return; }
            let token = args.get(2).unwrap();
            let owner = args.get(4).unwrap();
            let remaining: Vec<_> = records.lines().filter(|line| {
                field(line, "shareToken") != Some(token) || field(line, "envZId") != Some(owner)
            }).collect();
            fs::write(&state, remaining.join("\n")).unwrap();
            fs::write(root.join("deleted"), token).unwrap();
        }
        Some("share") => {
            assert!(args.iter().any(|arg| arg == "--force-local"));
            assert!(args.iter().any(|arg| arg == "--headless"));
            // Management commands must not replace these share-process receipts.
            fs::write(root.join("args"), args.join("\n")).unwrap();
            let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
            fs::write(root.join("child-home"), home.to_string_lossy().as_bytes()).unwrap();
            if let Ok(metadata) = fs::read(PathBuf::from(&home).join(".zrok2/metadata.json")) {
                fs::write(root.join("child-activation"), metadata).unwrap();
            }
            if mode == "startup-failure" { process::exit(3); }
            if mode == "delayed-registration" { thread::sleep(Duration::from_secs(3)); }
            let target = &args[2];
            let host = fs::read_to_string(root.join("public-host")).unwrap_or_else(|_| env::var("UNDERTREE_FIXTURE_PUBLIC_HOST").unwrap_or_else(|_| format!("{}.shares.zrok.io", args[4].strip_prefix("public:").unwrap())));
            if records.contains(&format!("\"{host}\"")) { process::exit(1); }
            let token = format!("fixture{}{}", process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos());
            let record = format!("{{\"shareToken\":\"{token}\",\"envZId\":\"fixture-enrollment\",\"target\":\"{target}\",\"frontendEndpoints\":[\"{host}\"],\"shareMode\":\"public\",\"backendMode\":\"proxy\"}}");
            fs::write(&state, format!("{records}\n{record}\n")).unwrap();
            let receipt = env::var_os("UNDERTREE_FIXTURE_TARGET").map(PathBuf::from).unwrap_or_else(||root.join("target"));
            fs::write(receipt, target).unwrap();
            fs::write(root.join("pid"), process::id().to_string()).unwrap();
            if mode == "share-exits" { process::exit(3); }
            if mode == "late-failure" { thread::sleep(Duration::from_secs(4)); process::exit(7); }
            thread::sleep(Duration::from_secs(600));
        }
        _ => process::exit(9),
    }
}
