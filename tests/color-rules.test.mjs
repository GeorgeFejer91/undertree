import assert from 'node:assert/strict';
import test from 'node:test';
import { composeRulePrompt, rulePromptParts } from '../src/color-rules.js';
import contract from '../modules/review/selective-editor-contract.json' with { type: 'json' };

test('editing presets preserves custom Unicode instructions and blank lines', () => {
  const custom = 'Preserve citations: García, 2026.\n\nKeep naïve 🌳 and e\u0301 intact.';
  for (const shorten of [false, true]) for (const detail of [false, true]) {
    const value = { shorten, detail, custom };
    assert.deepEqual(rulePromptParts(composeRulePrompt(value)), value);
  }
});

test('ordinary instructions are never silently interpreted or stripped as presets', () => {
  for (const custom of [
    '',
    'Shorten this passage, except its limitations.',
    '\nAdd useful detail and explanation without inventing facts or references.',
    'Keep this first line.\nShorten this passage while preserving its meaning and essential details.',
  ]) assert.deepEqual(rulePromptParts(custom), { shorten: false, detail: false, custom });
});

test('turning presets off keeps the exact custom prompt rather than discarded preset text', () => {
  const custom = 'No new facts.\nExplain the argument only where necessary.';
  const populated = rulePromptParts(composeRulePrompt({ shorten: true, detail: true, custom }));
  assert.equal(composeRulePrompt({ ...populated, shorten: false, detail: false }), custom);
});

test('all requested wording presets survive editing alongside the exact custom prompt', () => {
  for (const preset of contract.presets) {
    const original = { [preset.id]: true, custom: 'Keep this qualification.\n\nNo invented citations.' };
    const prompt = composeRulePrompt(original);
    assert.ok(prompt.startsWith(preset.prompt + '\n'));
    const parts = rulePromptParts(prompt);
    assert.equal(parts[preset.id], true);
    assert.equal(parts.custom, original.custom);
    assert.equal(composeRulePrompt(parts), prompt);
    assert.equal(composeRulePrompt({ ...parts, [preset.id]: false }), original.custom);
  }
});
