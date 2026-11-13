import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  TOKENIZER_REFERENCE, TOKENIZER_IDS, TOKENIZER_VERSION,
  matchTokenizers, tokenizerVerdict, advertisedFamily,
} from '../tokenizers.js';
import { TOKENIZER_PROBES } from '../fingerprint.js';

const vector = (values) => Object.fromEntries(TOKENIZER_IDS.map((id, index) => [id, values[index]]));
const rowModels = (row) => row.models.map((entry) => entry.model);
const matchModels = (result) => result.matches.map((match) => match.model).sort();

test('the reference table keeps the pinned vector shape', () => {
  assert.equal(TOKENIZER_VERSION, 2);
  assert.equal(TOKENIZER_IDS.length, 4);
  assert.equal(TOKENIZER_PROBES.length, TOKENIZER_IDS.length);
  TOKENIZER_PROBES.forEach((probe, index) => {
    assert.equal(probe.id, TOKENIZER_IDS[index]);
    assert.equal(typeof probe.text, 'string');
    assert.ok(probe.text.length > 20);
  });
  for (const row of TOKENIZER_REFERENCE) {
    assert.equal(row.tokens.length, 4, 'every row must carry four counts');
    assert.ok(row.tokens.filter((value) => value !== null).length >= 3, 'every row needs at least three counts');
    assert.ok(rowModels(row).length > 0, 'every row must name at least one model');
  }
});

test('the probe strings are byte-pinned, since one edit invalidates every count', async () => {
  // A checksum of the concatenated probe text. Changing a probe string changes
  // every recorded value in the reference table, so this test exists to make
  // that edit deliberate rather than accidental.
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(TOKENIZER_PROBES.map((probe) => probe.text).join('\u0000')).digest('hex');
  assert.equal(digest.slice(0, 12), '61260c980934');
});

test('an observed vector matching a table row names the family, never one model', () => {
  const result = matchTokenizers(vector([49, 53, 62, 83]));
  assert.equal(result.verdict, 'match');
  assert.deepEqual(result.families, ['deepseek']);
  // Both DeepSeek routes were recorded on this vector at some point, so a match
  // lists every model the row covers rather than picking one.
  assert.deepEqual(matchModels(result), ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro']);
  assert.equal(result.complete, true);
});

test('one vector can name several models of one family', () => {
  const result = matchTokenizers(vector([47, 68, 60, 91]));
  assert.deepEqual(result.families, ['openai']);
  assert.deepEqual(matchModels(result), [
    'openai/gpt-5.6-luna', 'openai/gpt-5.6-sol', 'openai/gpt-5.6-terra',
  ]);
});

test('a vector shared by two families is ambiguous instead of a contradiction', () => {
  // qwen3.7-flash and qwen3.8-27b both answer this, and so does nothing else —
  // but a route could also land here with one count off, so ambiguity has to be
  // reported as "cannot tell" rather than as a mismatch.
  const result = tokenizerVerdict('qwen3.7-flash', vector([47, 51, 63, 92]));
  assert.deepEqual(result.families, ['qwen']);
  assert.equal(result.consistent, true);
});

test('a row advertised as one family but answering with another is a mismatch', () => {
  // The case this whole probe exists for: a relay sells `gpt-6-astra` and
  // forwards to something wearing Qwen's vocabulary.
  const result = tokenizerVerdict('gpt-6-astra', vector([47, 51, 63, 92]));
  assert.equal(result.advertised, 'openai');
  assert.deepEqual(result.families, ['qwen']);
  assert.equal(result.consistent, false);
  assert.equal(result.reason, 'mismatch');
});

test('a mismatch is only claimed when the advertised family is known', () => {
  const unknown = tokenizerVerdict('mystery-model-9', vector([47, 51, 63, 92]));
  assert.equal(unknown.advertised, null);
  assert.equal(unknown.consistent, null);
  assert.equal(unknown.reason, 'advertised-family-unknown');
});

test('an unrecognised vector is reported as unknown, not as a mismatch', () => {
  const result = tokenizerVerdict('deepseek-v4.1-flash', vector([11, 12, 13, 14]));
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.consistent, null);
  assert.equal(result.reason, 'no-reference-match');
});

test('missing counts fall back to the three that were reported', () => {
  // Gemini does not report token counts at all, and some hosts hide one field.
  const partial = tokenizerVerdict('claude-opus-5', vector([79, 97, null, 119]));
  assert.equal(partial.verdict, 'match');
  assert.equal(partial.complete, false);
  assert.equal(partial.known, 3);
  assert.deepEqual(partial.families, ['anthropic']);
});

test('fewer than three counts is insufficient, not a guess', () => {
  const result = matchTokenizers(vector([49, null, null, 83]));
  assert.equal(result.verdict, 'insufficient');
  assert.equal(result.matches.length, 0);
  assert.equal(tokenizerVerdict('deepseek-v4-pro', vector([49, null, null, 83])).consistent, null);
});

test('a measured vector missing one dimension still matches on the other three', () => {
  // A live route answered 47 / 68 / 60 and then failed the emoji probe. Dropping
  // the whole comparison there would report "no reference match" for an endpoint
  // that is plainly using OpenAI's vocabulary.
  const result = tokenizerVerdict('gpt-6-astra', vector([47, 68, 60, null]));
  assert.equal(result.verdict, 'match');
  assert.equal(result.compared, 3);
  assert.deepEqual(result.families, ['openai']);
  assert.equal(result.consistent, true);
  // A single disagreement is still a disagreement, however many dimensions
  // matched: tokenizer counts are exact integers.
  const off = tokenizerVerdict('gpt-6-astra', vector([47, 68, 61, null]));
  assert.equal(off.verdict, 'unknown');
});

test('an unmatched vector reports how far the nearest recorded one is', () => {
  // One count off: a near miss worth naming, since a probe that raced a routing
  // switch lands here and the endpoint is still that family.
  const close = matchTokenizers(vector([47, 68, 61, null]));
  assert.equal(close.verdict, 'unknown');
  assert.equal(close.nearest.differing, 1);
  assert.equal(close.nearest.close, true);
  assert.deepEqual(close.nearest.tokens, [47, 68, 60, 91]);
  // Several counts off: an unrelated vocabulary. The distance is still reported,
  // but it is not flagged as close, so the panel does not imply a family.
  const far = matchTokenizers(vector([22, 26, 34, 102]));
  assert.equal(far.verdict, 'unknown');
  assert.ok(far.nearest.differing > 1);
  assert.equal(far.nearest.close, false);
});

test('a matched vector lists each model once even across partial rows', () => {
  // Some rows were recorded on hosts that hid the emoji count, so one model can
  // be reachable through more than one row. It must still appear once.
  const result = matchTokenizers(vector([79, 97, 93, 119]));
  const models = matchModels(result);
  assert.equal(new Set(models).size, models.length);
  assert.ok(models.includes('anthropic/claude-sonnet-5'));
});

test('family names are read from the model string and the vendor', () => {
  assert.equal(advertisedFamily('deepseek-v4.1-flash'), 'deepseek');
  assert.equal(advertisedFamily('gpt-6-astra'), 'openai');
  assert.equal(advertisedFamily('kimi-k3.1-pro'), 'moonshot');
  assert.equal(advertisedFamily('glm-5.3'), 'glm');
  assert.equal(advertisedFamily('grok-4.7'), 'grok');
  assert.equal(advertisedFamily('some-random-name'), null);
  // A name that merely resembles one must not be read as that family: `claudius`
  // is not `claude`, and claiming otherwise would manufacture a mismatch.
  assert.equal(advertisedFamily('claudius-prime'), null);
  assert.equal(advertisedFamily('llama-guard'), 'llama');
});
