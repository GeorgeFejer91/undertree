const test = require("node:test");
const assert = require("node:assert/strict");
const { normalize, prepareEntry, rankEntries } = require("./citation-search.js");

const prepared = [
  {
    key: "fejer2025heart",
    title: "Your Heart Does Not Lie",
    authors: "George Fejer; Ana Example",
    year: "2025",
    venue: "Journal of Cardiac Cognition",
    doi: "10.1000/heart",
  },
  {
    key: "reader2024memory",
    title: "Remembering Only Part of a Title",
    authors: "Morgan Reader",
    year: "2024",
    venue: "UnderTree Press",
    doi: "",
  },
  {
    key: "smith2025pulse",
    title: "Pulse Perception in Social Decisions",
    authors: "Taylor Smith",
    year: "2025",
    venue: "Cognitive Science",
    doi: "10.1000/pulse",
  },
].map(prepareEntry);

test("normalizes accents and punctuation into space-separated search tokens", () => {
  assert.equal(normalize("Féjer — Cardiac Cognition, 2025"), "fejer cardiac cognition 2025");
});

test("combines remembered terms across author, year, title, and venue", () => {
  assert.equal(rankEntries(prepared, "fejer 2025")[0].key, "fejer2025heart");
  assert.equal(rankEntries(prepared, "heart cognition")[0].key, "fejer2025heart");
  assert.equal(rankEntries(prepared, "reader 2024 title")[0].key, "reader2024memory");
});

test("tolerates a small spelling error and excludes already staged handles", () => {
  assert.equal(rankEntries(prepared, "cogniton")[0].key, "fejer2025heart");
  assert.equal(
    rankEntries(prepared, "2025", new Set(["fejer2025heart"]))[0].key,
    "smith2025pulse",
  );
});
