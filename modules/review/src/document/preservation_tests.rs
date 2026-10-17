use super::*;

fn mark(
    review: &mut Review,
    text: &str,
    name: &str,
    from: usize,
    to: usize,
    action: Action,
    mode: AccessMode,
) -> String {
    let id = Uuid::new_v4().to_string();
    let rule = Uuid::new_v4().to_string();
    review.rules.push(Rule {
        id: rule.clone(),
        label: name.into(),
        color: "#123456".into(),
        action,
        prompt: String::new(),
        access_mode: mode,
    });
    review.markers.push(Marker {
        id: id.clone(),
        rule,
        prompt: String::new(),
        anchor: Anchor::new(text, from, to).unwrap(),
    });
    id
}

#[test]
fn shared_protection_cases_reconstruct_using_native_ids_and_preserve_anchors() {
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../selective-editor-contract.json")).unwrap();
    for case in contract["preservationCases"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let mut review = Review::new(text);
        let mut identities = std::collections::BTreeMap::new();
        for marker in case["marks"].as_array().unwrap() {
            let name = marker["id"].as_str().unwrap();
            let id = mark(
                &mut review,
                text,
                name,
                marker["from"].as_u64().unwrap() as usize,
                marker["to"].as_u64().unwrap() as usize,
                serde_json::from_value(marker["action"].clone()).unwrap(),
                serde_json::from_value(marker["accessMode"].clone()).unwrap(),
            );
            identities.insert(name.to_owned(), id);
        }
        let before = review.markers.clone();
        let mut proposal = case["proposal"].clone();
        proposal["requestId"] = case["id"].clone();
        proposal["revision"] = serde_json::json!(digest(text));
        proposal["rationale"] = serde_json::json!("");
        for part in proposal["replacementParts"].as_array_mut().unwrap() {
            if let Some(name) = part["protectedId"].as_str() {
                part["protectedId"] = serde_json::json!(identities[name]);
            }
        }
        let result = review.propose(text, serde_json::from_value(proposal).unwrap());
        if case["result"] == "denied" {
            assert!(result.is_err(), "{}", case["id"]);
            continue;
        }
        let suggestion = result.unwrap_or_else(|error| panic!("{}: {}", case["id"], error.message));
        assert_eq!(
            review.allows_suggestion_direct(&suggestion).unwrap(),
            case["result"] == "applied",
            "{}",
            case["id"]
        );
        let changed = review
            .decide(text, &digest(text), &suggestion.id, Decision::Accepted)
            .unwrap();
        assert_eq!(
            changed,
            case["expectedText"].as_str().unwrap(),
            "{}",
            case["id"]
        );
        review.validate_for_text(&changed).unwrap();
        for original in before {
            let current = review
                .markers
                .iter()
                .find(|marker| marker.id == original.id)
                .unwrap();
            assert!(!current.anchor.stale, "{}", case["id"]);
            assert_eq!(current.rule, original.rule);
            if matches!(
                review.rule(&current.rule).unwrap().action,
                Action::Protect | Action::Reject
            ) {
                assert_eq!(current.anchor.quote, original.anchor.quote);
            }
        }
    }
}

fn fixture() -> (Review, String, Proposal) {
    let text = "One (A). Two (B).".to_owned();
    let mut review = Review::new(&text);
    mark(
        &mut review,
        &text,
        "paragraph",
        0,
        17,
        Action::Prompt,
        AccessMode::Direct,
    );
    let a = mark(
        &mut review,
        &text,
        "A",
        4,
        7,
        Action::Protect,
        AccessMode::Suggestions,
    );
    let b = mark(
        &mut review,
        &text,
        "B",
        13,
        16,
        Action::Reject,
        AccessMode::Suggestions,
    );
    let proposal = serde_json::from_value(serde_json::json!({"requestId":"rewrite","revision":digest(&text),"from":0,"to":17,"quote":text,"replacement":"","replacementParts":[{"protectedId":b},{"text":" before "},{"protectedId":a}],"rationale":""})).unwrap();
    (review, text, proposal)
}

#[test]
fn protected_mapping_rechecks_policy_and_forbids_forgery_duplication_partial_and_conflicting_units()
{
    let (review, text, proposal) = fixture();
    let mut pending = review.clone();
    let suggestion = pending.propose(&text, proposal.clone()).unwrap();
    pending.rules[1].prompt.push_str(" New local restriction.");
    assert_eq!(
        pending
            .decide(&text, &digest(&text), &suggestion.id, Decision::Accepted)
            .unwrap_err()
            .code,
        "protected"
    );
    for parts in [
        serde_json::json!([{"protectedId":"forged"}]),
        serde_json::json!([{"protectedId":review.markers[1].id},{"text":" (B)"}]),
        serde_json::json!([{"protectedId":review.markers[1].id,"text":"injected"}]),
    ] {
        let mut wire = serde_json::to_value(&proposal).unwrap();
        wire["replacementParts"] = parts;
        if let Ok(value) = serde_json::from_value(wire) {
            assert!(review.clone().propose(&text, value).is_err());
        }
    }
    let mut nested = review.clone();
    mark(
        &mut nested,
        &text,
        "nested",
        5,
        6,
        Action::Protect,
        AccessMode::Suggestions,
    );
    assert!(nested.propose(&text, proposal.clone()).is_err());
    let mut discard = review.clone();
    mark(
        &mut discard,
        &text,
        "discard",
        0,
        17,
        Action::Discard,
        AccessMode::Suggestions,
    );
    assert!(discard.propose(&text, proposal).is_err());
}

#[test]
fn protected_typst_objects_are_reinserted_verbatim_while_new_prose_is_escaped() {
    let text = "Before #cite(<a>) after.";
    let mut review = Review::new(text);
    mark(
        &mut review,
        text,
        "paragraph",
        0,
        text.len(),
        Action::Prompt,
        AccessMode::Direct,
    );
    let protected = mark(
        &mut review,
        text,
        "citation",
        7,
        17,
        Action::Protect,
        AccessMode::Suggestions,
    );
    let proposal = serde_json::from_value(serde_json::json!({"requestId":"field","revision":digest(text),"from":0,"to":text.len(),"quote":text,"replacement":"","replacementParts":[{"protectedId":protected},{"text":" preserved."}],"rationale":""})).unwrap();
    let suggestion = review.propose_format(text, proposal, true).unwrap();
    let changed = review
        .decide_format(
            text,
            &digest(text),
            &suggestion.id,
            Decision::Accepted,
            true,
        )
        .unwrap();
    assert_eq!(changed, "#cite(<a>) preserved\\.");
    review.validate_for_text(&changed).unwrap();
    assert_eq!(review.markers[1].anchor.quote, "#cite(<a>)");
}

#[test]
fn exact_native_undo_redo_restores_duplicate_identity_anchors_after_reopen_and_rule_changes_invalidate_it(
) {
    let text = "One (A). Two (A).";
    let mut review = Review::new(text);
    mark(
        &mut review,
        text,
        "paragraph",
        0,
        text.len(),
        Action::Prompt,
        AccessMode::Direct,
    );
    let a = mark(
        &mut review,
        text,
        "first",
        4,
        7,
        Action::Protect,
        AccessMode::Suggestions,
    );
    let b = mark(
        &mut review,
        text,
        "second",
        13,
        16,
        Action::Protect,
        AccessMode::Suggestions,
    );
    let before = review.markers.clone();
    let proposal=serde_json::from_value(serde_json::json!({"requestId":"same-citations","revision":digest(text),"from":0,"to":text.len(),"quote":text,"replacement":"","replacementParts":[{"protectedId":b},{"text":" then "},{"protectedId":a}],"rationale":""})).unwrap();
    let suggestion = review.propose(text, proposal).unwrap();
    let changed = review
        .decide(text, &digest(text), &suggestion.id, Decision::Accepted)
        .unwrap();
    let after = review.markers.clone();
    let serialized = serde_json::to_vec(&review).unwrap();
    let mut reopened: Review = serde_json::from_slice(&serialized).unwrap();
    reopened.reconcile(&changed, text);
    reopened.validate_for_text(text).unwrap();
    for (current, expected) in reopened.markers.iter().zip(&before) {
        assert_eq!(current.id, expected.id);
        assert_eq!(current.anchor, expected.anchor);
    }
    let mut reopened: Review =
        serde_json::from_slice(&serde_json::to_vec(&reopened).unwrap()).unwrap();
    reopened.reconcile(text, &changed);
    reopened.validate_for_text(&changed).unwrap();
    for (current, expected) in reopened.markers.iter().zip(&after) {
        assert_eq!(current.id, expected.id);
        assert_eq!(current.anchor, expected.anchor);
    }
    reopened.rules[1].prompt.push_str(" Changed locally.");
    reopened.reconcile(&changed, text);
    assert!(reopened
        .markers
        .iter()
        .filter(|marker| marker.id == a || marker.id == b)
        .all(|marker| marker.anchor.stale));
}

#[test]
fn oversized_undo_mapping_refuses_the_entire_protected_application() {
    let text = format!("Leading {} trailing", "a".repeat(24_000));
    let mut review = Review::new(&text);
    mark(
        &mut review,
        &text,
        "paragraph",
        0,
        text.len(),
        Action::Prompt,
        AccessMode::Direct,
    );
    let unit = mark(
        &mut review,
        &text,
        "unit",
        8,
        24_008,
        Action::Protect,
        AccessMode::Suggestions,
    );
    for _ in 0..12 {
        review.markers.push(Marker {
            id: Uuid::new_v4().to_string(),
            rule: "snappier".into(),
            prompt: String::new(),
            anchor: Anchor::new(&text, 8, 24_008).unwrap(),
        });
    }
    let proposal=serde_json::from_value(serde_json::json!({"requestId":"too-large","revision":digest(&text),"from":0,"to":text.len(),"quote":text,"replacement":"","replacementParts":[{"protectedId":unit},{"text":" moved"}],"rationale":""})).unwrap();
    let suggestion = review.propose(&text, proposal).unwrap();
    let before = serde_json::to_vec(&review).unwrap();
    assert_eq!(
        review
            .decide(&text, &digest(&text), &suggestion.id, Decision::Accepted)
            .unwrap_err()
            .code,
        "limit"
    );
    assert_eq!(serde_json::to_vec(&review).unwrap(), before);
}

#[test]
fn protected_word_identity_does_not_forbid_matching_words_or_substrings_in_new_prose() {
    let text = "The the claim.";
    let mut review = Review::new(text);
    mark(
        &mut review,
        text,
        "paragraph",
        0,
        text.len(),
        Action::Prompt,
        AccessMode::Direct,
    );
    let unit = mark(
        &mut review,
        text,
        "word",
        4,
        7,
        Action::Protect,
        AccessMode::Suggestions,
    );
    let proposal=serde_json::from_value(serde_json::json!({"requestId":"word","revision":digest(text),"from":0,"to":text.len(),"quote":text,"replacement":"","replacementParts":[{"text":"the theory keeps "},{"protectedId":unit},{"text":" intact"}],"rationale":""})).unwrap();
    let suggestion = review.propose(text, proposal).unwrap();
    let changed = review
        .decide(text, &digest(text), &suggestion.id, Decision::Accepted)
        .unwrap();
    assert_eq!(changed, "the theory keeps the intact");
    assert_eq!(
        review
            .markers
            .iter()
            .find(|marker| marker.id == unit)
            .unwrap()
            .anchor
            .from,
        17
    );
    review.validate_for_text(&changed).unwrap();
}
