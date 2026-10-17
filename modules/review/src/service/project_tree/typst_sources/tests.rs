use super::*;
use std::fs;

struct Fixture {
    temporary: tempfile::TempDir,
    root: Arc<RootedRoot>,
}

impl Fixture {
    fn new(files: &[(&str, &str)]) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        for (path, text) in files {
            let path = temporary.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        let observed = RootedRoot::observe(temporary.path()).unwrap();
        let root = RootedRoot::acquire(temporary.path(), &observed).unwrap();
        Self { temporary, root }
    }
}

fn paths(result: &TypstSources) -> Vec<&str> {
    result.paths.iter().map(String::as_str).collect()
}

#[test]
fn follows_nested_relative_rooted_and_escaped_imports_with_cycles_before_any_build() {
    let fixture = Fixture::new(&[
        ("manuscript/main.typ", "#import \"../shared/style.typ\": *\n#include \"sections/intro.typ\"\n#include \"/appendix.typ\""),
        ("shared/style.typ", "#import \"/manuscript/main.typ\": *"),
        ("manuscript/sections/intro.typ", "#include \"../../shared/append\\u{69}x.typ\""),
        ("shared/appendix.typ", "Appendix"),
        ("appendix.typ", "Rooted appendix"),
        ("unused.typ", "Unused"),
    ]);
    let result = discover(&fixture.root, "manuscript/main.typ");
    assert!(result.complete, "{:?}", result.reason);
    assert_eq!(result.main.as_deref(), Some("manuscript/main.typ"));
    assert_eq!(
        paths(&result),
        [
            "appendix.typ",
            "manuscript/main.typ",
            "manuscript/sections/intro.typ",
            "shared/appendix.typ",
            "shared/style.typ"
        ]
    );
}

#[test]
fn excludes_comments_strings_raw_text_assets_packages_and_unreferenced_sources() {
    let fixture = Fixture::new(&[
        ("main.typ", "// #include \"comment.typ\"\n/* #import \"block.typ\": * */\n#let text = \"#include \\\"string.typ\\\"\"\n`#include \"raw.typ\"`\n#import \"@preview/example:1.0.0\": *\n#let values = csv(\"data.csv\")\n#image(\"figure.svg\")\n#include \"part.typ\""),
        ("part.typ", "Actual source"),
        ("comment.typ", "Unrelated"),
        ("block.typ", "Unrelated"),
        ("string.typ", "Unrelated"),
        ("raw.typ", "Unrelated"),
        ("data.csv", "value\n1"),
        ("figure.svg", "<svg/>"),
    ]);
    let result = discover(&fixture.root, "main.typ");
    assert!(result.complete, "{:?}", result.reason);
    assert_eq!(paths(&result), ["main.typ", "part.typ"]);
}

#[test]
fn never_guesses_a_main_and_reports_missing_dynamic_and_invalid_dependencies() {
    let fixture = Fixture::new(&[
        ("main.typ", "#include \"missing.typ\""),
        ("dynamic.typ", "#let path = \"main.typ\"\n#include path"),
        (
            "incomplete.typ",
            "#include \"main.typ\"\n#let unfinished = (",
        ),
    ]);
    let absent = discover(&fixture.root, "");
    assert!(absent.main.is_none());
    assert!(absent.paths.is_empty());
    assert!(!absent.complete);
    assert!(absent.reason.unwrap().contains("Set as main document"));
    for main in [
        "main.typ",
        "dynamic.typ",
        "incomplete.typ",
        "absent.typ",
        "not-typst.txt",
    ] {
        let result = discover(&fixture.root, main);
        assert!(!result.complete, "{main}");
        assert!(result.reason.is_some());
        assert_eq!(result.main.as_deref(), Some(main));
    }
    assert_eq!(
        paths(&discover(&fixture.root, "dynamic.typ")),
        ["dynamic.typ"]
    );
}

#[test]
fn rejects_traversal_reserved_paths_and_oversized_sources_without_metadata_effects() {
    let fixture = Fixture::new(&[
        ("main.typ", "#include \"../outside.typ\"\n#include \"/For-AI/hidden.typ\"\n#include \"/node_modules/library.typ\"\n#include \"/.hidden.typ\"\n#include \"large.typ\""),
        ("For-AI/hidden.typ", "Hidden"),
        ("node_modules/library.typ", "Excluded"),
        (".hidden.typ", "Hidden"),
        ("main.typ.undertree-pending.json", "Preserve this incomplete journal exactly"),
    ]);
    fs::write(
        fixture.temporary.path().join("large.typ"),
        vec![b'x'; MAX_TEXT + 1],
    )
    .unwrap();
    let before = fs::read(
        fixture
            .temporary
            .path()
            .join("main.typ.undertree-pending.json"),
    )
    .unwrap();
    let result = discover(&fixture.root, "main.typ");
    assert!(!result.complete);
    assert_eq!(paths(&result), ["main.typ"]);
    assert_eq!(
        fs::read(
            fixture
                .temporary
                .path()
                .join("main.typ.undertree-pending.json")
        )
        .unwrap(),
        before
    );
    assert!(!fixture
        .temporary
        .path()
        .join("main.typ.undertree-review.json")
        .exists());
    assert_eq!(
        fs::read_to_string(fixture.temporary.path().join("For-AI/hidden.typ")).unwrap(),
        "Hidden"
    );
}

#[test]
fn bounds_file_count_total_bytes_and_response_paths() {
    let fixture = Fixture::new(&[("main.typ", "Main")]);
    let imports = (0..MAX_SOURCES + 5)
        .map(|index| {
            let name = format!("part-{index:04}.typ");
            fs::write(fixture.temporary.path().join(&name), "Part").unwrap();
            format!("#include \"{name}\"\n")
        })
        .collect::<String>();
    fs::write(fixture.temporary.path().join("main.typ"), imports).unwrap();
    let mut result = discover(&fixture.root, "main.typ");
    assert!(!result.complete);
    assert_eq!(result.paths.len(), MAX_SOURCES);
    result.fit_budget(512).unwrap();
    assert!(serde_json::to_vec(&result).unwrap().len() <= 512);
    assert!(!result.complete);
    let imports = (0..10)
        .map(|index| {
            let name = format!("large-{index}.typ");
            let text = format!("//{}", " ".repeat(MAX_TEXT - 2));
            fs::write(fixture.temporary.path().join(&name), text).unwrap();
            format!("#include \"{name}\"\n")
        })
        .collect::<String>();
    fs::write(fixture.temporary.path().join("main.typ"), imports).unwrap();
    let result = discover(&fixture.root, "main.typ");
    assert!(!result.complete);
    assert!(result.paths.len() < 11);
}

#[test]
fn rejects_hard_linked_source_files() {
    let fixture = Fixture::new(&[("main.typ", "#include \"linked.typ\"")]);
    let outside = tempfile::tempdir().unwrap();
    fs::write(
        outside.path().join("private.typ"),
        "#include \"/secret.typ\"",
    )
    .unwrap();
    fs::hard_link(
        outside.path().join("private.typ"),
        fixture.temporary.path().join("linked.typ"),
    )
    .unwrap();
    let result = discover(&fixture.root, "main.typ");
    assert!(!result.complete);
    assert_eq!(paths(&result), ["main.typ"]);
}

#[test]
fn reports_potentially_inactive_function_and_branch_imports_before_compiling() {
    let fixture = Fixture::new(&[
        (
            "main.typ",
            "#if false { include \"inactive.typ\" }\n#let unused() = { include \"function.typ\" }",
        ),
        ("inactive.typ", "Inactive"),
        ("function.typ", "Unused function"),
    ]);
    let result = discover(&fixture.root, "main.typ");
    assert!(!result.complete);
    assert!(result.reason.unwrap().contains("inactive"));
    assert_eq!(paths(&result), ["function.typ", "inactive.typ", "main.typ"]);
}

#[test]
fn current_compiler_receipt_resolves_computed_sources_and_stale_receipts_fall_back() {
    use crate::document::digest;
    use crate::service::Service;
    use crate::Operation;
    use serde_json::json;
    let main =
        "#let section = \"computed.typ\"\n#include section\n#if false { include \"inactive.typ\" }";
    let fixture = Fixture::new(&[
        ("main.typ", main),
        ("computed.typ", "Computed"),
        ("inactive.typ", "Inactive"),
        ("new.typ", "New"),
        ("data.csv", "value\n1"),
    ]);
    let state = tempfile::tempdir().unwrap();
    let service = Service::new(state.path().to_owned()).unwrap();
    let project = service
        .local(Operation::AddProject {
            root: fixture.temporary.path().to_str().unwrap().to_owned(),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    service
        .local(Operation::SetMainDocument {
            project: project.clone(),
            path: "main.typ".into(),
        })
        .unwrap();
    let tree = || {
        service
            .local(Operation::ProjectTree {
                project: project.clone(),
            })
            .unwrap()
    };
    assert_eq!(tree()["typstSources"]["complete"], false);
    assert!(!service.publishing_root().join("pdfs").exists());
    fs::create_dir(service.publishing_root().join("pdfs")).unwrap();
    let receipt_path = service
        .publishing_root()
        .join("pdfs")
        .join(format!("{}.json", digest(&format!("{project}:main.typ"))));
    let mut receipt = json!({
        "compiler_capture_version":1,"expected_root":fixture.root.observation(),
        "revision":digest(main),"inputs_stable":true,
        "dependencies":[
            {"path":"main.typ","revision":digest(main)},
            {"path":"computed.typ","revision":digest("Computed")},
            {"path":"data.csv","revision":digest("value\n1")}
        ]
    });
    fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
    assert_eq!(
        tree()["typstSources"]["paths"],
        json!(["computed.typ", "main.typ"])
    );
    assert_eq!(tree()["typstSources"]["complete"], true);
    receipt["source_epoch"] = json!(1);
    fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
    assert_eq!(tree()["typstSources"]["complete"], false);
    receipt["source_epoch"] = json!(0);
    fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
    fs::write(fixture.temporary.path().join("data.csv"), "value\n2").unwrap();
    assert_eq!(tree()["typstSources"]["complete"], false);
    fs::write(fixture.temporary.path().join("data.csv"), "value\n1").unwrap();
    assert_eq!(tree()["typstSources"]["complete"], true);
    fs::write(
        fixture.temporary.path().join("main.typ"),
        "#include \"new.typ\"",
    )
    .unwrap();
    assert_eq!(
        tree()["typstSources"]["paths"],
        json!(["main.typ", "new.typ"])
    );
    assert_eq!(tree()["typstSources"]["complete"], true);
    assert_eq!(
        fs::read(&receipt_path).unwrap(),
        serde_json::to_vec(&receipt).unwrap()
    );
    assert!(!fixture
        .temporary
        .path()
        .join("main.typ.undertree-review.json")
        .exists());
}

#[cfg(unix)]
#[test]
fn rejects_symlinked_source_files_and_parent_directories() {
    let fixture = Fixture::new(&[(
        "main.typ",
        "#include \"linked.typ\"\n#include \"linked/secret.typ\"",
    )]);
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.typ"), "Private").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.typ"),
        fixture.temporary.path().join("linked.typ"),
    )
    .unwrap();
    std::os::unix::fs::symlink(outside.path(), fixture.temporary.path().join("linked")).unwrap();
    let result = discover(&fixture.root, "main.typ");
    assert!(!result.complete);
    assert_eq!(paths(&result), ["main.typ"]);
}

#[test]
fn service_tree_adds_saved_main_closure_without_changing_full_inventory() {
    use crate::service::Service;
    use crate::Operation;
    let fixture = Fixture::new(&[
        ("main.typ", "#include \"part.typ\""),
        ("part.typ", "Part"),
        ("data/unused.typ", "Unused"),
        ("data/table.csv", "value\n1"),
    ]);
    let state = tempfile::tempdir().unwrap();
    let service = Service::new(state.path().to_owned()).unwrap();
    let project = service
        .local(Operation::AddProject {
            root: fixture.temporary.path().to_str().unwrap().to_owned(),
        })
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let before = service
        .local(Operation::ProjectTree {
            project: project.clone(),
        })
        .unwrap();
    assert_eq!(before["typstSources"]["main"], serde_json::Value::Null);
    assert_eq!(before["typstSources"]["complete"], false);
    service
        .local(Operation::SetMainDocument {
            project: project.clone(),
            path: "main.typ".into(),
        })
        .unwrap();
    let tree = service.local(Operation::ProjectTree { project }).unwrap();
    assert_eq!(tree["entries"], before["entries"]);
    assert_eq!(
        tree["typstSources"]["paths"],
        serde_json::json!(["main.typ", "part.typ"])
    );
    assert_eq!(tree["typstSources"]["complete"], true);
    assert_eq!(tree["typstSources"]["reason"], serde_json::Value::Null);
    assert!(!fixture
        .temporary
        .path()
        .join("main.typ.undertree-review.json")
        .exists());
}
