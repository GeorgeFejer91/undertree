"""Bounded, document-local policy shared by the UNO adapter and its tests."""
import hashlib
import colorsys
import json
import re
from pathlib import Path

MAX_TEXT = 2000000
MAX_MARKS = 500
MAX_RULES = 24
MAX_REPLACEMENT = 32768
PROPERTY = "UnderTreeReviewV1"

_contract_path = Path(__file__).with_name("selective-editor-contract.json")
if not _contract_path.is_file():
    _contract_path = Path(__file__).resolve().parents[2] / "review" / "selective-editor-contract.json"
CONTRACT = json.loads(_contract_path.read_text(encoding="utf-8"))
if CONTRACT.get("version") not in (1, 2) or CONTRACT["slots"] != {"visible": 4, "ruleLimit": MAX_RULES}:
    raise ValueError("Unsupported selective-editor UI contract.")


def digest(text, metadata):
    return hashlib.sha256((text + "\0" + json.dumps(metadata, sort_keys=True, ensure_ascii=False)).encode("utf-8")).hexdigest()


def defaults():
    return {"version": 1, "rules": {rule["id"]: {"name": rule["label"], "color": rule["color"], "prompt": rule["prompt"],
            "action": "edit" if rule["action"] == "prompt" else rule["action"],
            "mode": "suggestion" if rule["accessMode"] == "suggestions" else rule["accessMode"]} for rule in CONTRACT["defaultRules"]}, "marks": {}, "pending": []}


def validate_rule(rule):
    if not isinstance(rule, dict) or set(rule) != {"name", "color", "prompt", "action", "mode"}:
        raise ValueError("Invalid color rule.")
    for key, limit in (("name", CONTRACT["limits"]["ruleNameBytes"]), ("prompt", CONTRACT["limits"]["promptBytes"])):
        if not isinstance(rule[key], str) or (key == "name" and not rule[key].strip()) or len(rule[key].encode("utf-8")) > limit:
            raise ValueError("Enter a rule name and prompt within their size limits.")
    if not isinstance(rule["color"], str) or not re.fullmatch(r"#[0-9A-Fa-f]{6}", rule["color"]):
        raise ValueError("Use a color such as #B7E4C7.")
    if rule["action"] not in ("neutral", "edit", "protect", "reject", "discard") or rule["mode"] not in ("suggestion", "direct") or (rule["action"] != "edit" and rule["mode"] != "suggestion"):
        raise ValueError("Invalid rule access.")
    if rule["action"] == "neutral" and rule["prompt"]:
        raise ValueError("Color-only marks cannot carry a prompt or function.")


def validate_metadata(data):
    if not isinstance(data, dict) or not {"version", "rules", "marks"} <= set(data) or set(data) - {"version", "rules", "marks", "pending"} or data["version"] != 1:
        raise ValueError("Unsupported wrAIter metadata; original data was preserved.")
    if not isinstance(data["rules"], dict) or not isinstance(data["marks"], dict) or len(data["rules"]) > 64 or len(data["marks"]) > MAX_MARKS:
        raise ValueError("wrAIter metadata exceeds its limits.")
    for key, rule in data["rules"].items():
        if not isinstance(key, str) or len(key) > 80:
            raise ValueError("Invalid rule identifier.")
        validate_rule(rule)
    for key, mark in data["marks"].items():
        if not isinstance(key, str) or not key.startswith("UnderTree_") or len(key) > 80 or not isinstance(mark, dict) or not {"rule", "quote"} <= set(mark) or set(mark) - {"rule", "quote", "consumed", "prompt"}:
            raise ValueError("Invalid marked range.")
        if "consumed" in mark and not isinstance(mark["consumed"], bool):
            raise ValueError("Invalid marker permission state.")
        if "prompt" in mark and (not isinstance(mark["prompt"], str) or len(mark["prompt"].encode("utf-8")) > CONTRACT["limits"]["promptBytes"]):
            raise ValueError("Passage prompt exceeds its text limit.")
        if not isinstance(mark["rule"], str) or mark["rule"] not in data["rules"] or not isinstance(mark["quote"], str) or not mark["quote"] or len(mark["quote"]) > MAX_REPLACEMENT:
            raise ValueError("Invalid marked range content.")
        if data["rules"][mark["rule"]]["action"] == "neutral" and mark.get("prompt", ""):
            raise ValueError("Neutral marks cannot carry passage instructions.")
    pending = data.get("pending", [])
    if not isinstance(pending, list) or len(pending) > CONTRACT["limits"]["pendingSuggestions"]:
        raise ValueError("Pending suggestions exceed their metadata limit.")
    identifiers = set()
    for item in pending:
        if not isinstance(item, dict) or set(item) != {"proposal", "sourceDigest", "policyDigest"} or any(not isinstance(item[key], str) or not re.fullmatch(r"[0-9a-f]{64}", item[key]) for key in ("sourceDigest", "policyDigest")):
            raise ValueError("Invalid persisted suggestion binding.")
        proposal = item["proposal"]
        if not isinstance(proposal, dict) or not {"requestId", "from", "to", "quote", "replacement", "rationale"} <= set(proposal) or set(proposal) - {"requestId", "from", "to", "quote", "replacement", "rationale", "replacementParts"}:
            raise ValueError("Invalid persisted suggestion.")
        if "replacementParts" in proposal:
            validate_parts(proposal["replacementParts"], proposal["replacement"])
        if not isinstance(proposal["requestId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", proposal["requestId"]) or proposal["requestId"] in identifiers:
            raise ValueError("Invalid persisted suggestion identifier.")
        identifiers.add(proposal["requestId"])
        if any(isinstance(proposal[key], bool) or not isinstance(proposal[key], int) for key in ("from", "to")) or not 0 <= proposal["from"] < proposal["to"] <= MAX_TEXT * 2:
            raise ValueError("Invalid persisted suggestion range.")
        for key, maximum in (("quote", MAX_REPLACEMENT), ("replacement", MAX_REPLACEMENT), ("rationale", 4000)):
            if not isinstance(proposal[key], str) or len(proposal[key]) > maximum or "\x00" in proposal[key]:
                raise ValueError("Invalid persisted suggestion text.")
    return data


def utf16_length(text):
    return len(text.encode("utf-16-le")) // 2


def utf16_slice(text, start, end):
    encoded = text.encode("utf-16-le")
    if isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, int) or not isinstance(end, int) or not 0 <= start <= end <= len(encoded) // 2:
        raise ValueError("Invalid UTF-16 prose range.")
    try:
        return encoded[start * 2:end * 2].decode("utf-16-le")
    except UnicodeError:
        raise ValueError("Range boundaries must not split a Unicode character.")


def authorize(snapshot, arguments):
    keys = {"requestId", "revision", "contextId", "from", "to", "quote", "replacement", "rationale"}
    if not isinstance(arguments, dict) or not keys <= set(arguments) or set(arguments) - keys - {"replacementParts"}:
        raise ValueError("Supply requestId, revision, contextId, from, to, quote, replacement and rationale only.")
    if any(not isinstance(arguments[key], str) for key in keys - {"from", "to"}):
        raise ValueError("Proposal text fields must be strings.")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", arguments["requestId"]):
        raise ValueError("Use a stable requestId of at most 80 letters, digits, underscores or hyphens.")
    if arguments["revision"] != snapshot["revision"]:
        raise ValueError("Document or permissions changed; read the complete context again.")
    if len(arguments["replacement"]) > MAX_REPLACEMENT or "\x00" in arguments["replacement"]:
        raise ValueError("Replacement exceeds the text limit or contains a null character.")
    if len(arguments["rationale"].encode("utf-8")) > 4000:
        raise ValueError("Rationale exceeds its text limit.")
    start, end = arguments["from"], arguments["to"]
    quote = utf16_slice(snapshot["content"], start, end)
    if start == end or quote != arguments["quote"] or not quote or len(quote) > MAX_REPLACEMENT or quote == arguments["replacement"]:
        raise ValueError("Quote must exactly match a nonempty changed prose range.")
    if any(mark["stale"] and mark["action"] in ("protect", "reject", "discard") for mark in snapshot["markers"]):
        raise ValueError("A restrictive marker is stale; resolve it locally before submitting changes.")
    overlaps = [mark for mark in snapshot["markers"] if mark["start"] < end and start < mark["end"]]
    protected = [mark for mark in overlaps if mark["action"] in ("protect", "reject")]
    replacement, placements = reconstruct(snapshot, arguments, protected)
    for other in overlaps:
        if other["action"] == "discard":
            if replacement or start > other["start"] or end < other["end"]:
                raise ValueError("Every overlapping discard marker requires a complete removal suggestion.")
    current = [mark for mark in overlaps if not mark["stale"] and mark["action"] in ("edit", "discard")]
    covered = start
    for mark in sorted(current, key=lambda item: item["start"]):
        if mark["start"] > covered:
            break
        covered = max(covered, mark["end"])
    if covered < end:
        raise ValueError("The complete requested range must be highlighted; unmarked gaps and boundary overruns are forbidden.")
    mode = "suggestion" if any(mark["mode"] == "suggestion" or mark["action"] == "discard" for mark in current) else "direct"
    return {"mode": mode, "markers": current, "start": start, "end": end, "replacement": replacement, "protected": placements}



def validate_parts(parts, replacement):
    if replacement or not isinstance(parts, list) or not 1 <= len(parts) <= 128:
        raise ValueError("replacementParts requires an empty replacement and 1–128 exact parts.")
    total = 0
    for part in parts:
        if not isinstance(part, dict) or len(part) != 1 or set(part) not in ({"text"}, {"protectedId"}):
            raise ValueError("Each replacement part contains text or one protectedId only.")
        value = next(iter(part.values()))
        if not isinstance(value, str) or "\x00" in value or ("protectedId" in part and not value):
            raise ValueError("Invalid replacement part.")
        total += len(value)
    if total > MAX_REPLACEMENT:
        raise ValueError("Replacement parts exceed the text limit.")


def reconstruct(snapshot, arguments, protected=None):
    start, end = arguments["from"], arguments["to"]
    protected = protected if protected is not None else [mark for mark in snapshot["markers"]
        if mark["start"] < end and start < mark["end"] and mark["action"] in ("protect", "reject")]
    if "replacementParts" not in arguments:
        if protected:
            raise ValueError("Protected overlaps require exact native protectedId parts.")
        return arguments["replacement"], []
    validate_parts(arguments["replacementParts"], arguments["replacement"])
    ordered = sorted(protected, key=lambda mark: mark["start"])
    if any(mark["stale"] or mark["start"] < start or mark["end"] > end for mark in ordered):
        raise ValueError("Every protected unit must be current and wholly enclosed.")
    if any(left["end"] > right["start"] for left, right in zip(ordered, ordered[1:])):
        raise ValueError("Conflicting overlapping protected units require local resolution.")
    if protected and not any(mark["action"] == "edit" and not mark["stale"] and mark["start"] <= start and mark["end"] >= end for mark in snapshot["markers"]):
        raise ValueError("Protected movement requires a separately authorized enclosing prompt marker.")
    units = {mark["id"]: mark for mark in protected}
    seen, pieces, placements = set(), [], []
    offset = 0
    for part in arguments["replacementParts"]:
        if "text" in part:
            value = part["text"]
        else:
            identifier = part["protectedId"]
            if identifier not in units or identifier in seen:
                raise ValueError("Unknown, out-of-scope or repeated protected identity.")
            seen.add(identifier)
            unit = units[identifier]
            value = unit["text"]
            placements.append({"marker": unit, "from": start + offset, "to": start + offset + utf16_length(value)})
        offset += utf16_length(value)
        pieces.append(value)
    replacement = "".join(pieces)
    if seen != set(units) or len(replacement) > MAX_REPLACEMENT or replacement == arguments["quote"]:
        raise ValueError("Preserve every protected unit exactly once in a changed bounded replacement.")
    return replacement, placements


def authorize_highlight(snapshot, marking, metadata):
    keys = {"requestId", "contextId", "revision", "ranges"}
    if not isinstance(marking, dict) or not keys <= set(marking) or set(marking) - keys - {"colorId"}:
        raise ValueError("Supply only requestId, contextId, revision, optional colorId and exact ranges.")
    if any(not isinstance(marking[key], str) for key in keys - {"ranges"}) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", marking["requestId"]):
        raise ValueError("Invalid marking identity or context.")
    if marking["revision"] != snapshot["revision"]:
        raise ValueError("Document or permissions changed; read complete context again.")
    ranges = marking["ranges"]
    if not isinstance(ranges, list) or not 1 <= len(ranges) <= 64 or len(metadata["marks"]) + len(ranges) > MAX_MARKS:
        raise ValueError("Use 1–64 ranges within the document's 500-mark limit.")
    previous, total = -1, 0
    for item in ranges:
        if not isinstance(item, dict) or set(item) != {"from", "to", "quote"} or not isinstance(item["quote"], str):
            raise ValueError("Each range contains only from, to and quote.")
        quote = utf16_slice(snapshot["content"], item["from"], item["to"])
        if not quote or quote != item["quote"] or item["from"] < previous or len(quote) > MAX_REPLACEMENT or "\x00" in quote:
            raise ValueError("Marking ranges must be ordered, disjoint, exact nonempty Unicode quotes.")
        previous = item["to"]
        total += len(quote)
    if total > MAX_REPLACEMENT:
        raise ValueError("Marking batch exceeds its 32768-character limit.")
    if any(mark["stale"] and mark["action"] in ("protect", "reject", "discard") for mark in snapshot["markers"]):
        raise ValueError("Resolve stale restrictive markers locally before adding coloration.")
    if "colorId" in marking:
        identifier = marking["colorId"]
        rule = metadata["rules"].get(identifier) if isinstance(identifier, str) else None
        if rule is None or rule["action"] != "neutral" or rule["prompt"] or rule["mode"] != "suggestion":
            raise ValueError("Only a still-functionless neutral color identity can be reused.")
        return identifier, rule
    if len(metadata["rules"]) >= MAX_RULES:
        raise ValueError("No free color slot is available; remove a color locally first.")
    used = [tuple(bytes.fromhex(rule["color"][1:])) for rule in metadata["rules"].values()]
    for index in range(720):
        rgb = tuple(round(channel * 255) for channel in colorsys.hls_to_rgb((index * 0.61803398875) % 1, .7, .7))
        if all(sum((a-b)**2 for a, b in zip(rgb, old)) >= 2500 for old in used):
            return None, {"name": "AI color " + str(len(metadata["rules"]) + 1), "color": "#%02x%02x%02x" % rgb,
                          "action": "neutral", "prompt": "", "mode": "suggestion"}
    raise ValueError("No distinguishable unused color is available.")

def public_snapshot(snapshot):
    result = {"documentId": snapshot["documentId"], "revision": snapshot["revision"],
            "snapshot": "live", "content": snapshot["content"], "context": snapshot["context"],
            "offsetEncoding": "UTF-16", "scope": "Complete current Writer text is read-only context. Changes require complete highlight coverage in the main-body content; other context parts are read-only.",
            "markers": [{**{key: ("" if key == "text" and mark["stale"] else value) for key, value in mark.items() if key not in ("start", "end")},
                         "from": mark["start"], "to": mark["end"]} for mark in snapshot["markers"]]}
    if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > 1048576:
        raise ValueError("Complete context and highlights exceed 1 MiB. No partial context was provided.")
    return result
