(function installCitationSearch(globalScope) {
  const SEARCH_FIELDS = ["key", "title", "authors", "year", "venue", "doi"];
  const FIELD_WEIGHTS = {
    key: 1.35,
    title: 1.2,
    authors: 1.25,
    year: 1.3,
    venue: 1,
    doi: 0.9,
  };

  function normalize(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function prepareEntry(entry) {
    const fields = Object.fromEntries(
      SEARCH_FIELDS.map((field) => [field, normalize(entry?.[field])]),
    );
    const words = Object.fromEntries(
      SEARCH_FIELDS.map((field) => [field, fields[field].split(" ").filter(Boolean)]),
    );
    return { entry, fields, words };
  }

  function boundedEditDistance(left, right, limit = 2) {
    if (Math.abs(left.length - right.length) > limit) return limit + 1;
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const current = [leftIndex];
      let rowMinimum = current[0];
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        const substitution = previous[rightIndex - 1]
          + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
        current[rightIndex] = Math.min(
          previous[rightIndex] + 1,
          current[rightIndex - 1] + 1,
          substitution,
        );
        rowMinimum = Math.min(rowMinimum, current[rightIndex]);
      }
      if (rowMinimum > limit) return limit + 1;
      previous = current;
    }
    return previous[right.length];
  }

  function tokenFieldScore(token, value, words) {
    if (!value) return 0;
    if (value === token) return 720;
    if (words.includes(token)) return 650;
    if (value.startsWith(token)) return 520;
    if (words.some((word) => word.startsWith(token))) return 470;
    if (value.includes(token)) return 320;

    if (token.length >= 4) {
      let bestDistance = 3;
      for (const word of words) {
        if (word.length < 3) continue;
        bestDistance = Math.min(bestDistance, boundedEditDistance(token, word, 2));
      }
      if (bestDistance <= 2) return 150 - bestDistance * 35;
    }
    return 0;
  }

  function scoreEntry(prepared, query) {
    const normalizedQuery = normalize(query);
    const tokens = [...new Set(normalizedQuery.split(" ").filter(Boolean))];
    if (!tokens.length) return 1;

    let score = 0;
    for (const token of tokens) {
      let best = 0;
      for (const field of SEARCH_FIELDS) {
        best = Math.max(
          best,
          tokenFieldScore(token, prepared.fields[field], prepared.words[field])
            * FIELD_WEIGHTS[field],
        );
      }
      if (!best) return 0;
      score += best;
    }

    if (prepared.fields.key === normalizedQuery) score += 1_000;
    if (prepared.fields.key.startsWith(normalizedQuery)) score += 500;
    if (prepared.fields.title.includes(normalizedQuery)) score += 360;
    if (prepared.fields.authors.includes(normalizedQuery)) score += 320;
    if (prepared.fields.venue.includes(normalizedQuery)) score += 240;
    return score;
  }

  function rankEntries(preparedEntries, query, excludedKeys = new Set(), limit = 9) {
    return preparedEntries
      .filter(({ entry }) => !excludedKeys.has(entry.key))
      .map((prepared) => ({ prepared, score: scoreEntry(prepared, query) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        const yearComparison = String(right.prepared.entry.year || "")
          .localeCompare(String(left.prepared.entry.year || ""), undefined, { numeric: true });
        if (yearComparison) return yearComparison;
        return String(left.prepared.entry.key || "")
          .localeCompare(String(right.prepared.entry.key || ""), undefined, { sensitivity: "base" });
      })
      .slice(0, Math.max(1, limit))
      .map(({ prepared }) => prepared.entry);
  }

  const api = { normalize, prepareEntry, rankEntries, scoreEntry };
  globalScope.UnderTreeCitationSearch = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis === "undefined" ? window : globalThis);
