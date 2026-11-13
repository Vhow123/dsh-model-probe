// Tokenizer reference table.
//
// A model's tokenizer lives in the vendor's own vocabulary files and is not
// something a relay can imitate: sending text and reading back how many prompt
// tokens the endpoint counted exposes it directly, with no cooperation from the
// model and no reference to what the model says about itself.
//
// Two limits are worth stating up front, because both were measured:
//
//   1. A tokenizer identifies a FAMILY, not one model. Three OpenAI models share
//      one vector, Qwen's 3.7-flash and 3.8-27b share another, and several hosts
//      serve the same underlying weights. "This endpoint uses DeepSeek's
//      tokenizer" is a fact; "this endpoint is DeepSeek-V4-Pro" is not.
//   2. A model whose route does not report token counts (Gemini here) yields no
//      vector at all. The probe must say so instead of guessing.
//
// The reference values come from unclecode/modelprint (MIT),
// https://github.com/unclecode/modelprint, read on 2026-11-13. They are counts
// of a fixed string MINUS the same host's count for a one-character prompt,
// which cancels the hidden serving template out. Any change to the probe strings
// changes every number, so the strings are pinned here and versioned with the
// table.
//
// The table lists every DISTINCT vector that project ever recorded, not one row
// per model: 23 models over 350 tracked versions collapse into 55 different
// vectors, because a model keeps one vector until it is switched to different
// weights. Keeping only the newest row per model (what version 1 of this file
// did) threw away the older, still-served variants: DeepSeek-V4-Pro alone moved
// through 27 vectors, and a route legitimately serving one of them looked like
// an unknown tokenizer.
//
// A vector that is recorded here but still absent from this table means one of
// two things, and both are reported honestly rather than guessed at: the route
// counts tokens with a vocabulary nobody has published yet, or the probe text
// was tokenized by a different serving template than the one the reference host
// used. The panel shows the closest recorded vector and how many dimensions
// differ.
//
// Refresh procedure: re-read the upstream repository, rebuild the rows below,
// bump TOKENIZER_VERSION, and run `node --test test/tokenizers.test.js`; the test
// pins the vector shape and the probe checksum.

export const TOKENIZER_VERSION = 2;

export const TOKENIZER_REFERENCE = [
  { tokens: [47, 68, 60, 91], models: [{ model: "openai/gpt-5.6-sol", vendor: "OpenAI", versions: 22 }, { model: "openai/gpt-5.6-luna", vendor: "OpenAI", versions: 14 }, { model: "openai/gpt-5.6-terra", vendor: "OpenAI", versions: 13 }] },
  { tokens: [47, 56, 60, 90], models: [{ model: "z-ai/glm-5.3-flash", vendor: null, versions: 24 }, { model: "z-ai/glm-5.3", vendor: "Z.AI", versions: 14 }, { model: "z-ai/glm-4.7-flash", vendor: "DeepInfra", versions: 8 }, { model: "stealth/ox-alpha", vendor: "Stealth", versions: 2 }] },
  { tokens: [49, 53, 62, 83], models: [{ model: "deepseek/deepseek-v4-flash", vendor: "SiliconFlow", versions: 20 }, { model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 15 }] },
  { tokens: [47, 76, 60, 93], models: [{ model: "unbiased/pareto", vendor: null, versions: 11 }, { model: "nousresearch/hermes-4-405b", vendor: "Nebius", versions: 10 }] },
  { tokens: [47, 51, 63, 92], models: [{ model: "qwen/qwen3.7-flash", vendor: "Alibaba", versions: 10 }, { model: "qwen/qwen3.8-27b", vendor: "Chutes", versions: 10 }] },
  { tokens: [47, 58, 60, 57], models: [{ model: "qwen/qwen3-235b-a22b-2507", vendor: "Alibaba", versions: 18 }] },
  { tokens: [48, 59, 65, 53], models: [{ model: "x-ai/grok-4.6", vendor: "xAI", versions: 16 }] },
  { tokens: [44, 57, 68, 73], models: [{ model: "google/gemma-3-27b-it", vendor: "DeepInfra", versions: 14 }] },
  { tokens: [49, 53, 60, 83], models: [{ model: "minimax/minimax-m3", vendor: "AtlasCloud", versions: 14 }] },
  { tokens: [79, 97, null, 119], models: [{ model: "anthropic/claude-opus-5", vendor: "Anthropic", versions: 11 }] },
  { tokens: [79, 97, 93, 119], models: [{ model: "anthropic/claude-sonnet-5", vendor: "Anthropic", versions: 9 }] },
  { tokens: [49, 53, 62, 4], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 7 }] },
  { tokens: [47, 50, 60, 76], models: [{ model: "moonshotai/kimi-k3", vendor: "DigitalOcean", versions: 7 }] },
  { tokens: [56, 98, 72, 120], models: [{ model: "anthropic/claude-haiku-4.5", vendor: "Anthropic", versions: 6 }] },
  { tokens: [47, 68, 67, 91], models: [{ model: "openai/gpt-5.6-luna", vendor: "OpenAI", versions: 3 }, { model: "openai/gpt-5.6-terra", vendor: "OpenAI", versions: 3 }] },
  { tokens: [47, 75, 60, 91], models: [{ model: "openai/gpt-5.6-luna", vendor: "OpenAI", versions: 3 }, { model: "openai/gpt-5.6-terra", vendor: "OpenAI", versions: 3 }] },
  { tokens: [47, 68, 60, 98], models: [{ model: "openai/gpt-5.6-terra", vendor: "OpenAI", versions: 3 }, { model: "openai/gpt-5.6-luna", vendor: "OpenAI", versions: 2 }] },
  { tokens: [47, 56, 60, 91], models: [{ model: "z-ai/glm-5.3-flash", vendor: null, versions: 5 }] },
  { tokens: [49, null, 62, 4], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 4 }] },
  { tokens: [49, null, 62, 83], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 3 }] },
  { tokens: [49, 53, null, 83], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 3 }] },
  { tokens: [41, 45, 54, 75], models: [{ model: "unbiased/pareto", vendor: null, versions: 3 }] },
  { tokens: [null, 53, 62, 4], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 2 }] },
  { tokens: [49, 132, null, 83], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 2 }] },
  { tokens: [47, 76, 60, null], models: [{ model: "unbiased/pareto", vendor: null, versions: 2 }] },
  { tokens: [47, 76, 60, 74], models: [{ model: "unbiased/pareto", vendor: null, versions: 2 }] },
  { tokens: [38, 42, 51, 72], models: [{ model: "unbiased/pareto", vendor: null, versions: 2 }] },
  { tokens: [47, 76, 39, 93], models: [{ model: "unbiased/pareto", vendor: null, versions: 2 }] },
  { tokens: [62, 71, 60, 106], models: [{ model: "z-ai/glm-5.3-flash", vendor: null, versions: 2 }] },
  { tokens: [49, 132, 62, 83], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 1 }] },
  { tokens: [49, null, 141, 83], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 1 }] },
  { tokens: [75, 27, 62, 83], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 1 }] },
  { tokens: [49, 53, 62, null], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 1 }] },
  { tokens: [128, 53, null, 83], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 1 }] },
  { tokens: [128, 132, null, 83], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 1 }] },
  { tokens: [null, 53, 141, 83], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 1 }] },
  { tokens: [49, 53, null, 4], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 1 }] },
  { tokens: [128, 132, null, 4], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 1 }] },
  { tokens: [49, 132, null, 4], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 1 }] },
  { tokens: [null, 132, 62, 4], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 1 }] },
  { tokens: [49, 53, 141, 4], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 1 }] },
  { tokens: [49, null, 141, 4], models: [{ model: "deepseek/deepseek-v4-pro", vendor: "GMICloud", versions: 1 }] },
  { tokens: [47, 68, 67, 98], models: [{ model: "openai/gpt-5.6-luna", vendor: "OpenAI", versions: 1 }] },
  { tokens: [54, 68, 60, 98], models: [{ model: "openai/gpt-5.6-terra", vendor: "OpenAI", versions: 1 }] },
  { tokens: [47, 98, 60, null], models: [{ model: "unbiased/pareto", vendor: null, versions: 1 }] },
  { tokens: [47, 76, 38, 93], models: [{ model: "unbiased/pareto", vendor: null, versions: 1 }] },
  { tokens: [69, 98, 82, 115], models: [{ model: "unbiased/pareto", vendor: null, versions: 1 }] },
  { tokens: [47, 76, 60, 51], models: [{ model: "unbiased/pareto", vendor: null, versions: 1 }] },
  { tokens: [41, 45, 63, 75], models: [{ model: "unbiased/pareto", vendor: null, versions: 1 }] },
  { tokens: [68, 97, 60, 114], models: [{ model: "unbiased/pareto", vendor: null, versions: 1 }] },
  { tokens: [68, 76, 60, 93], models: [{ model: "unbiased/pareto", vendor: null, versions: 1 }] },
  { tokens: [47, 76, 39, 74], models: [{ model: "unbiased/pareto", vendor: null, versions: 1 }] },
  { tokens: [62, 56, 60, 91], models: [{ model: "z-ai/glm-5.3-flash", vendor: null, versions: 1 }] },
  { tokens: [62, 56, 60, 90], models: [{ model: "z-ai/glm-5.3-flash", vendor: null, versions: 1 }] },
  { tokens: [62, 71, 76, 106], models: [{ model: "z-ai/glm-5.3-flash", vendor: null, versions: 1 }] },
];

// Probe order is part of the vector contract: entry 0 is the English pangram,
// 1 the Chinese paragraph, 2 the Python snippet, 3 the emoji line.
export const TOKENIZER_IDS = ['tok-english', 'tok-chinese', 'tok-code', 'tok-emoji'];

// Which vendor family name a model string advertises. Used only to notice that a
// row called `gpt-6-astra` answers with a DeepSeek tokenizer — a mismatch, not
// proof. Unknown names return null and are never treated as a mismatch.
const FAMILIES = [
  { family: 'openai', pattern: /(^|[\/\s-])(gpt|o1|o3|o4|chatgpt|davinci)/i },
  { family: 'anthropic', pattern: /claude/i },
  { family: 'deepseek', pattern: /deepseek/i },
  { family: 'qwen', pattern: /(^|[\/\s-])(qwen|tongyi|qwq)/i },
  { family: 'glm', pattern: /(^|[\/\s-])(glm|zhipu|chatglm)/i },
  { family: 'moonshot', pattern: /(kimi|moonshot)/i },
  { family: 'gemini', pattern: /(gemini|gemma|palm)/i },
  { family: 'grok', pattern: /grok/i },
  { family: 'minimax', pattern: /minimax|abab/i },
  { family: 'llama', pattern: /(llama|hermes|mistral|mixtral)/i },
];

// The family a reference model name belongs to, derived from the same table so
// the two sides of a comparison are always labelled by one rule.
function familyOf(name, vendor) {
  for (const entry of FAMILIES) {
    if (entry.pattern.test(name || '')) return entry.family;
    if (vendor && entry.pattern.test(vendor)) return entry.family;
  }
  return null;
}

export function advertisedFamily(model) {
  return familyOf(model, null);
}

// Compare an observed vector against the table.
//
// A dimension is skipped when either side has no value: some hosts never report
// one of the counts, some table rows were recorded on hosts that hid one, and
// dropping the whole comparison over a single missing number throws away the
// three that were measured. At least three dimensions must actually be compared,
// and every compared dimension must agree exactly — a tokenizer count is an
// integer with no noise, so "close" is meaningless here.
export function matchTokenizers(observed) {
  const values = TOKENIZER_IDS.map((id) => {
    const value = observed?.[id];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  });
  const known = values.filter((value) => value !== null).length;
  if (known < 3) {
    return { complete: false, known, values, matches: [], families: [], compared: 0, nearest: null, verdict: 'insufficient' };
  }
  const matches = [];
  // A row with a hidden dimension matches on the dimensions it does record, so
  // the same model can be reached through more than one row (for example a full
  // four-count row and a three-count row recorded on a host that hid the emoji
  // count). Collect by model, keeping the row that compared the most.
  const byModel = new Map();
  // Kept for the unmatched case: the closest recorded row and how far off it is.
  // Reporting "unknown" without a distance leaves the reader unable to tell a
  // near miss (one count differing, most likely a probe that raced a routing
  // switch) from a vocabulary that is simply not in the table. `close` marks the
  // former, so the panel can phrase the two differently.
  let nearest = null;
  for (const entry of TOKENIZER_REFERENCE) {
    let compared = 0;
    let differing = 0;
    for (let index = 0; index < TOKENIZER_IDS.length; index += 1) {
      const expected = entry.tokens[index];
      const actual = values[index];
      if (expected === null || actual === null) continue;
      compared += 1;
      if (expected !== actual) differing += 1;
    }
    if (compared < 3) continue;
    if (differing === 0) {
      for (const model of entry.models) {
        const key = `${model.model}`;
        const previous = byModel.get(key);
        if (!previous || compared > previous.compared) {
          byModel.set(key, {
            model: model.model,
            vendor: model.vendor,
            versions: model.versions,
            family: familyOf(model.model, model.vendor),
            compared,
          });
        }
      }
      continue;
    }
    if (!nearest || differing < nearest.differing || (differing === nearest.differing && compared > nearest.compared)) {
      nearest = { tokens: entry.tokens, differing, compared, models: entry.models };
    }
  }
  if (nearest) nearest = { ...nearest, close: nearest.differing === 1 };
  matches.push(...byModel.values());
  const families = [...new Set(matches.map((match) => match.family).filter(Boolean))];
  return {
    complete: known === TOKENIZER_IDS.length,
    known,
    values,
    matches,
    families,
    compared: matches.length ? Math.max(...matches.map((match) => match.compared)) : 0,
    nearest,
    verdict: matches.length ? 'match' : 'unknown',
  };
}

// Decide whether the model's advertised family contradicts the measured one.
// Only a single, unambiguous measured family can contradict anything: when the
// vector matches two families the honest answer is "cannot tell".
export function tokenizerVerdict(model, observed) {
  const measured = matchTokenizers(observed);
  const advertised = advertisedFamily(model);
  if (measured.verdict === 'insufficient') {
    return { ...measured, advertised, consistent: null, reason: 'insufficient' };
  }
  if (!measured.matches.length) {
    return { ...measured, advertised, consistent: null, reason: 'no-reference-match' };
  }
  if (!advertised) {
    return { ...measured, advertised, consistent: null, reason: 'advertised-family-unknown' };
  }
  if (measured.families.length !== 1) {
    return { ...measured, advertised, consistent: null, reason: 'ambiguous-family' };
  }
  const consistent = measured.families[0] === advertised;
  return { ...measured, advertised, consistent, reason: consistent ? 'consistent' : 'mismatch' };
}
