import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import contract from '../modules/review/selective-editor-contract.json' with { type: 'json' };
import { composeRulePrompt, rulePromptParts } from '../src/color-rules.js';

test('shared presets preserve exact prompt meaning and custom passage instructions', () => {
  const custom = 'Preserve citations: García 🌳 e\u0301.';
  const choices = { ...Object.fromEntries(contract.presets.map(preset => [preset.id, true])), custom };
  const composed = composeRulePrompt(choices);
  assert.equal(composed, [...contract.presets.map(preset => preset.prompt), custom].join('\n'));
  assert.deepEqual(rulePromptParts(composed), choices);
  assert.equal(contract.labels.shareContext, 'Share complete document for context; edits stay inside highlights');
});

test('Writer and UnderTree use identical shipped default colors, prompts, actions and access choices', () => {
  const run = spawnSync(process.env.UNDERTREE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-B', '-c', 'import json,sys;sys.path.insert(0,sys.argv[1]);from undertree_policy import defaults;print(json.dumps(defaults()["rules"]))', resolve('modules/libreoffice/extension')], { encoding: 'utf8' });
  assert.equal(run.error, undefined, 'Python is required to verify the Writer selective-editor contract.');
  assert.equal(run.status, 0, run.stderr);
  const writer = JSON.parse(run.stdout);
  const mapped = Object.entries(writer).map(([id, rule]) => ({ id, label: rule.name, color: rule.color, prompt: rule.prompt, action: rule.action === 'edit' ? 'prompt' : rule.action, accessMode: rule.mode === 'suggestion' ? 'suggestions' : rule.mode }));
  assert.deepEqual(mapped, contract.defaultRules);
  assert.ok(mapped.every(rule => rule.accessMode === 'suggestions'));
});

test('shared range scenarios use exact UTF-16 quotes and cover permission and completeness boundaries', () => {
  assert.equal(new Set(contract.rangeCases.map(item => item.id)).size, contract.rangeCases.length);
  for (const scenario of contract.rangeCases) {
    assert.equal(scenario.text.slice(scenario.proposal.from, scenario.proposal.to), scenario.proposal.quote, scenario.id);
    assert.ok(scenario.marks.every(mark => mark.from < mark.to && mark.to <= scenario.text.length), scenario.id);
  }
  const scenarios = new Set(contract.scenarios.map(item => item.id));
  for (const id of ['missing_complete_context', 'stale_context', 'dirty_context', 'unhighlighted_change', 'highlight_boundary_overrun', 'unmarked_gap', 'revoked_access', 'highlighted_subrange', 'adjacent_highlight_union', 'passage_prompt_preserved']) assert.ok(scenarios.has(id), id);
});
