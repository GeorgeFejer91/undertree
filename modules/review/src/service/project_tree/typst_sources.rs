use super::super::{source_path, Member, RootedRoot, MAX_TEXT};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use typst_syntax::{ast, ast::AstNode, SyntaxKind};

const MAX_SOURCES: usize = 512;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_NODES: usize = 250_000;
const MAX_PATH_BYTES: usize = 128 * 1024;

#[derive(Serialize)]
pub(super) struct TypstSources {
    main: Option<String>,
    paths: BTreeSet<String>,
    complete: bool,
    reason: Option<&'static str>,
}

impl TypstSources {
    pub(super) fn complete_paths(self) -> crate::Result<(String, BTreeSet<String>)> {
        if !self.complete {
            return Err(crate::Error::new("context_incomplete", self.reason.unwrap_or("The manuscript context is incomplete.")));
        }
        Ok((self.main.ok_or_else(|| crate::Error::new("context_incomplete", "Choose the manuscript's main document."))?, self.paths))
    }
    fn partial(&mut self, reason: &'static str) {
        self.complete = false;
        self.reason.get_or_insert(reason);
    }

    pub(super) fn fit_budget(&mut self, maximum: usize) -> crate::Result<()> {
        if serde_json::to_vec(self)?.len() <= maximum {
            return Ok(());
        }
        self.partial("The saved Typst source list exceeds the project tree response limit.");
        let mut bytes = serde_json::to_vec(self)?.len();
        while bytes > maximum {
            let Some(path) = self
                .paths
                .iter()
                .rev()
                .find(|path| Some(*path) != self.main.as_ref())
                .cloned()
            else {
                return Err(crate::Error::new(
                    "limit",
                    "The Typst source status exceeds its response limit.",
                ));
            };
            self.paths.remove(&path);
            bytes = bytes.saturating_sub(
                serde_json::to_vec(&path)?.len() + usize::from(!self.paths.is_empty()),
            );
        }
        Ok(())
    }
}

pub(super) fn from_compiler(
    root: &Arc<RootedRoot>,
    main: &str,
    paths: BTreeSet<String>,
) -> Option<TypstSources> {
    if !paths.contains(main) || paths.len() > MAX_SOURCES {
        return None;
    }
    let mut bytes = 0;
    let mut path_bytes = 0;
    for path in &paths {
        source_path::validate_source_path(path).ok()?;
        path_bytes += path.len() + 8;
        if path_bytes > MAX_PATH_BYTES || bytes >= MAX_BYTES {
            return None;
        }
        let source = root
            .source_group(path)
            .ok()?
            .read_utf8(Member::Source, MAX_TEXT.min(MAX_BYTES - bytes))
            .ok()?;
        bytes += source.text().ok()??.len();
    }
    root.check_current().ok()?;
    Some(TypstSources {
        main: Some(main.to_owned()),
        paths,
        complete: true,
        reason: None,
    })
}

fn typst(path: &str) -> bool {
    Path::new(path).extension().and_then(|value| value.to_str()) == Some("typ")
}

fn resolve(from: &str, target: &str) -> Option<String> {
    resolve_path(from, target, false)
}

fn resolve_path(from: &str, target: &str, context_text: bool) -> Option<String> {
    if target.is_empty() || target.contains('\\') || target.contains(':') {
        return None;
    }
    let mut components: Vec<_> = if target.starts_with('/') {
        Vec::new()
    } else {
        from.rsplit_once('/')
            .map_or(Vec::new(), |(parent, _)| parent.split('/').collect())
    };
    for component in target.trim_start_matches('/').split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop()?;
            }
            name => components.push(name),
        }
    }
    let relative = components.join("/");
    let text = context_text && ["bib","yaml","yml","json","csv","tsv","txt","md","xml","csl"].contains(&Path::new(&relative).extension()?.to_str()?);
    ((typst(&relative) || text) && source_path::validate_source_path(&relative).is_ok()).then_some(relative)
}

struct Discovery {
    strict_context: bool,
    result: TypstSources,
    pending: Vec<String>,
    scheduled: BTreeSet<String>,
    bytes: usize,
    nodes: usize,
    path_bytes: usize,
}

impl Discovery {
    fn context_loader(&mut self, from: &str, expression: ast::Expr<'_>) {
        match expression {
            ast::Expr::Str(literal) => {
                if let Some(path) = resolve_path(from, &literal.get(), true) {
                    self.schedule(path);
                } else {
                    self.result.partial("A manuscript text input is outside supported approved project paths.");
                }
            }
            ast::Expr::Array(array) => {
                for item in array.items() {
                    if let ast::ArrayItem::Pos(expression) = item { self.context_loader(from, expression); }
                    else { self.result.partial("Computed manuscript text inputs require a new supported literal scope."); }
                }
            }
            _ => self.result.partial("Computed manuscript text inputs cannot establish complete context."),
        }
    }

    fn schedule(&mut self, path: String) {
        if self.scheduled.contains(&path) {
            return;
        }
        if self.scheduled.len() >= MAX_SOURCES || self.path_bytes + path.len() + 8 > MAX_PATH_BYTES
        {
            self.result
                .partial("The saved Typst source graph exceeds its file or path limit.");
            return;
        }
        self.path_bytes += path.len() + 8;
        self.scheduled.insert(path.clone());
        self.pending.push(path);
    }

    fn imports(&mut self, from: &str, text: &str) {
        let syntax = typst_syntax::parse(text);
        if syntax.diagnosis().errors {
            self.result.partial("Some saved Typst source has incomplete syntax; only resolved literal imports are shown.");
        }
        let mut frames = vec![(syntax.children(), false)];
        while let Some((children, conditional)) = frames.last_mut() {
            let conditional = *conditional;
            let Some(node) = children.next() else {
                frames.pop();
                continue;
            };
            self.nodes += 1;
            if self.nodes > MAX_NODES {
                self.result
                    .partial("The saved Typst source graph exceeds its syntax inspection limit.");
                return;
            }
            if self.strict_context {
                if let Some(call) = node.cast::<ast::FuncCall>() {
                    if let ast::Expr::Ident(callee) = call.callee() {
                        let name = callee.as_str();
                        if ["read","csv","json","yaml","xml","toml","bibliography"].contains(&name) {
                            let mut found = false;
                            for argument in call.args().items() {
                                match argument {
                                    ast::Arg::Pos(expression) if !found => { self.context_loader(from, expression); found = true; }
                                    ast::Arg::Named(named) if name == "bibliography" && named.name().as_str() == "style" => {
                                        if let ast::Expr::Str(style) = named.expr() {
                                            if style.get().ends_with(".csl") { self.context_loader(from, named.expr()); }
                                        } else { self.result.partial("Computed bibliography styles cannot establish complete context."); }
                                    }
                                    ast::Arg::Spread(_) => self.result.partial("Spread manuscript loader arguments are unresolved."),
                                    _ => {}
                                }
                            }
                            if !found || conditional { self.result.partial("Conditional or unresolved manuscript text loaders are incomplete."); }
                            frames.push((call.args().to_untyped().children(), conditional));
                            continue;
                        }
                    }
                }
                if let Some(identifier) = node.cast::<ast::Ident>() {
                    if ["read","csv","json","yaml","xml","toml","bibliography","eval","std","sys","plugin"].contains(&identifier.as_str()) {
                        self.result.partial("Aliased or evaluated external manuscript text cannot establish complete context.");
                    }
                }
            }
            let source = node
                .cast::<ast::ModuleImport>()
                .map(|import| import.source())
                .or_else(|| {
                    node.cast::<ast::ModuleInclude>()
                        .map(|include| include.source())
                });
            if let Some(source) = source {
                if conditional {
                    self.result.partial("Saved imports inside functions or branches may include inactive files; compile to refine this view.");
                }
                if let ast::Expr::Str(literal) = source {
                    let target = literal.get();
                    if !target.starts_with('@') {
                        if let Some(relative) = resolve(from, &target) {
                            self.schedule(relative);
                        } else {
                            self.result.partial("A saved Typst import is outside the supported project source paths.");
                        }
                    } else if self.strict_context {
                        self.result.partial("External package manuscript context is outside the approved source scope.");
                    }
                } else {
                    self.result.partial("Computed Typst imports cannot be resolved without compilation; only literal imports are shown.");
                }
            }
            let conditional = conditional
                || matches!(
                    node.kind(),
                    SyntaxKind::Conditional
                        | SyntaxKind::Closure
                        | SyntaxKind::ForLoop
                        | SyntaxKind::WhileLoop
                );
            frames.push((node.children(), conditional));
        }
    }

    fn read(&mut self, root: &Arc<RootedRoot>, relative: &str) {
        let source = root.source_group(relative).and_then(|group| {
            group.read_utf8(Member::Source, MAX_TEXT.min(MAX_BYTES - self.bytes))
        });
        match source {
            Ok(source) => match source.text() {
                Ok(Some(text)) => {
                    self.bytes += text.len();
                    self.result.paths.insert(relative.to_owned());
                    if typst(relative) { self.imports(relative, text); }
                }
                _ => self.result.partial("A referenced saved Typst source is missing or is not readable UTF-8."),
            },
            Err(_) => self.result.partial("A referenced saved Typst source could not be read safely within the source limits."),
        }
    }
}

pub(super) fn discover(root: &Arc<RootedRoot>, main: &str) -> TypstSources {
    discover_mode(root, main, false)
}

pub(super) fn discover_context(root: &Arc<RootedRoot>, main: &str) -> TypstSources {
    discover_mode(root, main, true)
}

fn discover_mode(root: &Arc<RootedRoot>, main: &str, strict_context: bool) -> TypstSources {
    let mut discovery = Discovery {
        strict_context,
        result: TypstSources {
            main: (!main.is_empty()).then(|| main.to_owned()),
            paths: BTreeSet::new(),
            complete: true,
            reason: None,
        },
        pending: Vec::new(),
        scheduled: BTreeSet::new(),
        bytes: 0,
        nodes: 0,
        path_bytes: 0,
    };
    if main.is_empty() {
        discovery
            .result
            .partial("Choose Set as main document on a Typst file to show its saved source files.");
    } else if typst(main) && source_path::validate_source_path(main).is_ok() {
        discovery.schedule(main.to_owned());
        while let Some(relative) = discovery.pending.pop() {
            if discovery.bytes >= MAX_BYTES || discovery.nodes > MAX_NODES {
                discovery
                    .result
                    .partial("The saved Typst source graph exceeds its inspection limits.");
                break;
            }
            discovery.read(root, &relative);
        }
    } else {
        discovery
            .result
            .partial("Choose an existing Typst main document to show its saved source files.");
    }
    discovery.result
}

#[cfg(test)]
mod tests;
