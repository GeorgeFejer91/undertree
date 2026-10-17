use std::{env, fs, io::Write, path::Path};

// Native equivalents of the server test's POSIX process hooks; never a compiler.
fn main() {
    let executable = env::current_exe().unwrap();
    let name = executable.file_stem().unwrap().to_str().unwrap();
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    match name {
        "file-manager" => fs::write(
            env::var_os("LOCALTEX_TEST_FILE_MANAGER_REQUEST").unwrap(),
            arguments.first().unwrap().to_str().unwrap(),
        )
        .unwrap(),
        "codex-desktop" => fs::write(
            env::var_os("LOCALTEX_TEST_CODEX_DESKTOP_REQUEST").unwrap(),
            format!("{}\n", arguments.first().unwrap().to_str().unwrap()),
        )
        .unwrap(),
        "codex" => {
            fs::write(
                env::var_os("LOCALTEX_TEST_CODEX_INVOCATION").unwrap(),
                "unexpected Codex invocation\n",
            )
            .unwrap();
            std::process::exit(2);
        }
        "preview-normalizer" => {
            let mut input = None;
            let mut output = None;
            for argument in &arguments {
                let argument = argument.to_str().unwrap();
                if let Some(path) = argument.strip_prefix("-sOutputFile=") {
                    output = Some(path);
                } else if argument.ends_with(".pdf") {
                    input = Some(argument);
                }
            }
            let output = Path::new(output.unwrap());
            fs::copy(input.unwrap(), output).unwrap();
            fs::OpenOptions::new()
                .append(true)
                .open(output)
                .unwrap()
                .write_all(b"\n%% LocalTeX preview normalized\n")
                .unwrap();
        }
        _ => panic!("Unknown server fixture hook: {name}"),
    }
}
