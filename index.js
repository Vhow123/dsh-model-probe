import { performance } from 'node:perf_hooks';
import { intelligenceModel, INTELLIGENCE_PROBES, checkIntelligenceAnswer } from './intelligence.js';
import { fingerprintModel, BEHAVIOR_PROBES, FINGERPRINT_PROBES, DETERMINISTIC_PROBES, TOKENIZER_PROBES, behaviorCheck, buildSignature, compareSignature, mergeBaseline, jsd, bootstrapNoise, parseNumbers, histogramOf, driftThreshold, memoryStore, fileStore, baselinePath, distributionPrompt } from './fingerprint.js';
import { TOKENIZER_REFERENCE, TOKENIZER_IDS, TOKENIZER_VERSION, matchTokenizers, tokenizerVerdict, advertisedFamily } from './tokenizers.js';

export { intelligenceModel, INTELLIGENCE_PROBES, checkIntelligenceAnswer };
export { fingerprintModel, BEHAVIOR_PROBES, FINGERPRINT_PROBES, DETERMINISTIC_PROBES, TOKENIZER_PROBES, behaviorCheck, buildSignature, compareSignature, mergeBaseline, jsd, bootstrapNoise, parseNumbers, histogramOf, driftThreshold, memoryStore, fileStore, baselinePath, distributionPrompt };
export { TOKENIZER_REFERENCE, TOKENIZER_IDS, TOKENIZER_VERSION, matchTokenizers, tokenizerVerdict, advertisedFamily };

export const name = 'dsh-model-probe';
export const inject = ['webServer', 'llm'];

const API = '/api/dsh-model-probe';
const DEFAULT_TIMEOUT = 45000;
const DEFAULT_MAX_TOKENS = 32;
const SVG_TIMEOUT = 300000;
const SVG_MAX_TOKENS = 16384;
const SVG_MAX_BYTES = 32768;
const PROMPT = 'Reply with OK only.';
const SVG_PROMPT = 'Generate an animated SVG of a pelican riding a bicycle. Reply with SVG code only.\n\nUse native SVG SMIL animation, especially <animate> and <animateTransform>, to visibly rotate the bicycle wheels and move the pelican or bicycle. Include at least one visible looping animation with repeatCount="indefinite" and a duration between 2 and 6 seconds. Nest animation elements inside their target shapes. Output one complete SVG only. Do not use scripts, CSS, <style>, <use>, external resources or links.';
const CUSTOM_SVG_CONTRACT = 'Create one complete standalone SVG image for the user request below. Reply with SVG code only, starting with <svg and ending with </svg>. Do not include Markdown fences, explanations, HTML, or any text outside the SVG. Keep it self-contained. Use a concise, stylized composition with simple shapes; keep the SVG under 12,000 bytes and 100 elements so the closing </svg> is always emitted. Do not use scripts, CSS, <style>, <use>, external resources or links. If the request asks for animation, use native SVG SMIL animation.\n\nUser request:\n';
const CUSTOM_SVG_QUICK_CONTRACT = CUSTOM_SVG_CONTRACT.replace(
  'Use a concise, stylized composition with simple shapes; keep the SVG under 12,000 bytes and 100 elements',
  'Use a minimal flat pictogram made from simple geometric silhouettes, not a detailed illustration. Avoid text, gradients, textures, fine details and complex paths. Keep the SVG under 3,000 bytes and at most 24 elements including the root <svg> element'
);
const CUSTOM_SVG_QUICK_LIMITS = { maxBytes: 3000, maxElements: 30 };
const HTML_TIMEOUT = 600000;
const HTML_MAX_TOKENS = 65536;
const HTML_MAX_BYTES = 64000;
const HTML_CONTRACT = 'Create one complete, self-contained HTML document that draws the requested scene with inline SVG. Reply with the HTML document only, starting with <!doctype html> and ending with </html>. Do not use Markdown fences and do not add explanations. Everything must be inline: no external scripts, stylesheets, fonts, images or URLs. CSS inside <style> is allowed and CSS animations (@keyframes) are encouraged; native SVG SMIL animation is also fine. Start writing the document immediately and keep any planning brief. Keep the document under 64,000 bytes and let the drawing fill the viewport.\n\nUser request:\n';
const HTML_BRIEF = '请生成可直接运行的单文件HTML，使用内联SVG绘制鹈鹕骑自行车的二维循环动画。画面以鹈鹕和自行车为主体，展示清晰的身体结构、踩踏动作和车轮转动，配合协调的背景、配色与层次。动画应流畅自然、衔接连续，并适配不同屏幕尺寸。禁止依赖外部资源，只输出完整HTML，不要代码围栏或解释文字。';
const HTML_SHELL_CSS = 'html,body{margin:0;height:100%;overflow:hidden;background:#fff}body{display:flex;align-items:center;justify-content:center}svg{display:block;max-width:100%;max-height:100%}';

function textOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-***')
    .slice(0, 1200);
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function loopback(req) {
  const address = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false;
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  let local;
  try { local = new URL(`http://${host}`); } catch { return false; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (req.headers.origin === undefined) return true;
  try { return new URL(req.headers.origin).host === local.host; } catch { return false; }
}

function guard(req, res) {
  if (!loopback(req)) {
    writeJson(res, 403, { ok: false, message: '仅允许本机同源请求' });
    return false;
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, message: '仅支持 POST' });
    return false;
  }
  return true;
}

export async function readCatalog(llm) {
  const providers = llm.listProviders();
  const groups = await Promise.all(providers.map(async (provider) => {
    try {
      const models = await llm.listModels(provider.id);
      return {
        provider: provider.id,
        name: provider.name || provider.displayName || provider.id,
        models: models.map((model) => ({ id: model.id, name: model.name || model.id })),
      };
    } catch (error) {
      return { provider: provider.id, name: provider.name || provider.id, models: [], error: redact(textOf(error)) };
    }
  }));
  return { groups, total: groups.reduce((sum, group) => sum + group.models.length, 0) };
}

export function sanitizeSvg(text, options = {}) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const match = source.match(/<svg(?:\s[^>]*)?>[\s\S]*?<\/svg\s*>/i);
  if (!match) throw new Error('模型回复中没有完整的 SVG');
  let svg = match[0]
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|foreignObject|iframe|object|embed|image|use|style|discard)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|foreignObject|iframe|object|embed|image|use|style|discard)\b[^>]*\/\s*>/gi, '')
    .replace(/\s+(?:on[a-z0-9_-]+|href|xlink:href|src|srcdoc|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/url\(\s*['"]?\s*(?!#)[^)]*\)/gi, 'none');
  if (/<(?:script|foreignObject|iframe|object|embed|image|use|style|discard)\b/i.test(svg) || /\son[a-z0-9_-]+\s*=/i.test(svg) || /(?:javascript|data):/i.test(svg)) {
    throw new Error('SVG 含有不支持的脚本或外部内容');
  }
  for (const tag of svg.matchAll(/<(?:animate|animateMotion|animateTransform|set)\b[^>]*>/gi)) {
    const attribute = tag[0].match(/\battributeName\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const target = (attribute?.[1] || attribute?.[2] || attribute?.[3] || '').trim().toLowerCase();
    if (target.startsWith('on') || ['href', 'xlink:href', 'src', 'style'].includes(target)) {
      throw new Error('SVG 动画不能修改事件、链接或样式属性');
    }
  }
  svg = svg.trim();
  const bytes = Buffer.byteLength(svg, 'utf8');
  const elementCount = (svg.match(/<[A-Za-z][^>]*>/g) || []).length;
  const animationCount = (svg.match(/<(?:animate|animateMotion|animateTransform)\b/gi) || []).length;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : SVG_MAX_BYTES;
  const maxElements = Number.isFinite(options.maxElements) ? options.maxElements : Infinity;
  if (bytes > maxBytes) throw new Error(`清洗后 SVG 超过 ${maxBytes === SVG_MAX_BYTES ? `${maxBytes / 1024} KiB` : `${maxBytes} 字节`}`);
  if (elementCount > maxElements) throw new Error(`SVG 超过 ${maxElements} 个元素（实际 ${elementCount} 个）`);
  return { svg, bytes, elementCount, animationCount };
}

function stripFence(text) {
  const source = String(text || '').replace(/^\uFEFF/, '').trim();
  const fenced = source.match(/```(?:html|svg|xml)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : source).trim();
}

function cleanCss(css) {
  return String(css || '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/url\(\s*(['"]?)(?!#)[^)]*\)/gi, 'none')
    .replace(/javascript:/gi, '');
}

function htmlShell(fragment) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${HTML_SHELL_CSS}</style></head><body>${fragment}</body></html>`;
}

function countColors(html) {
  const seen = new Set();
  for (const match of html.matchAll(/(?:fill|stroke|stop-color|flood-color|background(?:-color)?|color)\s*[:=]\s*(["']?)(#[0-9a-f]{3,8})\b/gi)) {
    seen.add(match[2].toLowerCase());
  }
  return seen.size;
}

function attrOf(source, name) {
  const found = source.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return found ? found[1] : '';
}

function numOf(source, name) {
  const value = Number.parseFloat(attrOf(source, name));
  return Number.isFinite(value) ? value : 0;
}

const PATH_ARITY = { m: 2, l: 2, t: 2, h: 1, v: 1, c: 6, s: 4, q: 4, a: 7, z: 0 };

// Walks the path grammar so arc flags and relative commands do not shift the
// numbers and invent coordinates that never existed.
function pathPoints(d) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  const points = [];
  let index = 0, x = 0, y = 0, startX = 0, startY = 0, command = '';
  while (index < tokens.length) {
    if (/^[a-z]$/i.test(tokens[index])) {
      command = tokens[index];
      index += 1;
      if (/z/i.test(command)) { x = startX; y = startY; points.push([x, y]); continue; }
    }
    const size = PATH_ARITY[command.toLowerCase()];
    if (!size) { index += 1; continue; }
    const args = tokens.slice(index, index + size).map(Number);
    if (args.length < size || args.some((value) => !Number.isFinite(value))) { index += size; continue; }
    index += size;
    const key = command.toLowerCase();
    const relative = command === key;
    const move = (px, py) => [relative ? x + px : px, relative ? y + py : py];
    if (key === 'm') {
      [x, y] = move(args[0], args[1]);
      startX = x;
      startY = y;
      command = relative ? 'l' : 'L';
    } else if (key === 'h') {
      x = relative ? x + args[0] : args[0];
    } else if (key === 'v') {
      y = relative ? y + args[0] : args[0];
    } else if (key === 'a') {
      [x, y] = move(args[5], args[6]);
    } else if (key === 'c') {
      points.push(move(args[0], args[1]), move(args[2], args[3]));
      [x, y] = move(args[4], args[5]);
    } else if (key === 's' || key === 'q') {
      points.push(move(args[0], args[1]));
      [x, y] = move(args[2], args[3]);
    } else if (key === 't') {
      [x, y] = move(args[0], args[1]);
    } else {
      [x, y] = move(args[0], args[1]);
    }
    points.push([x, y]);
  }
  return points;
}

const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];

function multiplyMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function applyMatrix(matrix, x, y) {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

function parseTransform(text) {
  let matrix = IDENTITY_MATRIX;
  for (const part of text.matchAll(/(translate|scale|rotate|matrix|skewX|skewY)\s*\(([^)]*)\)/gi)) {
    const args = (part[2].match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
    const radians = ((args[0] || 0) * Math.PI) / 180;
    let next = IDENTITY_MATRIX;
    if (/^translate$/i.test(part[1])) {
      next = [1, 0, 0, 1, args[0] || 0, args[1] || 0];
    } else if (/^scale$/i.test(part[1])) {
      const sx = args[0] ?? 1;
      next = [sx, 0, 0, args[1] ?? sx, 0, 0];
    } else if (/^rotate$/i.test(part[1])) {
      const cos = Math.cos(radians), sin = Math.sin(radians);
      const cx = args[1] || 0, cy = args[2] || 0;
      next = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
    } else if (/^matrix$/i.test(part[1])) {
      next = [args[0] ?? 1, args[1] ?? 0, args[2] ?? 0, args[3] ?? 1, args[4] ?? 0, args[5] ?? 0];
    } else if (/^skewx$/i.test(part[1])) {
      next = [1, 0, Math.tan(radians), 1, 0, 0];
    } else {
      next = [1, Math.tan(radians), 0, 1, 0, 0];
    }
    matrix = multiplyMatrix(matrix, next);
  }
  return matrix;
}

// Rough, dependency-free framing check: how far the drawn geometry strays outside
// the declared viewport. Group transforms are composed, otherwise every drawing
// that positions parts with translate() would look like it overflows.
function drawingOverflow(html) {
  const root = html.match(/<svg\b([^>]*)>/i);
  if (!root) return null;
  let box = null;
  const viewBox = attrOf(root[1], 'viewBox').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    box = viewBox;
  } else {
    const width = Number.parseFloat(attrOf(root[1], 'width'));
    const height = Number.parseFloat(attrOf(root[1], 'height'));
    if (width > 0 && height > 0) box = [0, 0, width, height];
  }
  if (!box) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let sawShape = false;
  const push = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  let matrix = IDENTITY_MATRIX;
  const stack = [];
  // Shapes inside <defs>, <symbol>, <clipPath>, <mask>, <marker> and <pattern> are
  // templates drawn at the origin and placed elsewhere by <use>, so measuring them
  // in place reports phantom overflow for every drawing that reuses parts.
  const TEMPLATE_TAGS = 'defs|symbol|clippath|mask|marker|pattern';
  let templateDepth = 0;
  // A group moved by <animateTransform type="translate"> has no fixed position, so
  // its static bounding box says nothing about what the viewer ends up seeing.
  let motion = false;
  const motionStack = [];
  for (const el of html.matchAll(/<(\/?)(svg|g|rect|circle|ellipse|line|polyline|polygon|path|defs|symbol|clipPath|mask|marker|pattern|animateTransform)\b([^>]*)>/gi)) {
    const tag = el[2].toLowerCase();
    const isTemplate = TEMPLATE_TAGS.split('|').includes(tag);
    if (el[1] === '/') {
      if (isTemplate) {
        if (templateDepth > 0) templateDepth -= 1;
        continue;
      }
      if (tag === 'g' || tag === 'svg') {
        matrix = stack.pop() || IDENTITY_MATRIX;
        motion = motionStack.pop() || false;
      }
      continue;
    }
    if (tag === 'animatetransform') {
      if (!motion && /translate|matrix|rotate/i.test(attrOf(el[3], 'type'))) motion = true;
      continue;
    }
    if (isTemplate) {
      if (!/\/\s*$/.test(el[3])) templateDepth += 1;
      continue;
    }
    if (templateDepth > 0 || motion) {
      // Keep the element stack balanced so the matching close tag does not pop the
      // wrong entry, but do not measure anything inside an animated group.
      if (tag === 'g' && !/\/\s*$/.test(el[3])) {
        stack.push(matrix);
        motionStack.push(motion);
      }
      continue;
    }
    if (tag === 'g' || tag === 'svg') {
      const selfClosing = /\/\s*$/.test(el[3]);
      if (selfClosing) continue;
      stack.push(matrix);
      motionStack.push(motion);
      const transform = attrOf(el[3], 'transform');
      if (transform) matrix = multiplyMatrix(matrix, parseTransform(transform));
      continue;
    }
    const body = el[3];
    const ownTransform = attrOf(body, 'transform');
    const ownMatrix = ownTransform ? multiplyMatrix(matrix, parseTransform(ownTransform)) : matrix;
    let shapeMinX = Infinity, shapeMinY = Infinity, shapeMaxX = -Infinity, shapeMaxY = -Infinity;
    const corners = [];
    if (tag === 'rect') {
      const x = numOf(body, 'x'), y = numOf(body, 'y');
      const w = numOf(body, 'width'), h = numOf(body, 'height');
      corners.push([x, y], [x + w, y], [x, y + h], [x + w, y + h]);
    } else if (tag === 'circle') {
      const cx = numOf(body, 'cx'), cy = numOf(body, 'cy'), r = numOf(body, 'r');
      corners.push([cx - r, cy - r], [cx + r, cy + r]);
    } else if (tag === 'ellipse') {
      const cx = numOf(body, 'cx'), cy = numOf(body, 'cy');
      const rx = numOf(body, 'rx'), ry = numOf(body, 'ry');
      corners.push([cx - rx, cy - ry], [cx + rx, cy + ry]);
    } else if (tag === 'line') {
      corners.push([numOf(body, 'x1'), numOf(body, 'y1')], [numOf(body, 'x2'), numOf(body, 'y2')]);
    } else if (tag === 'path') {
      corners.push(...pathPoints(attrOf(body, 'd')));
    } else {
      for (const pair of attrOf(body, 'points').matchAll(/(-?\d*\.?\d+)[\s,]+(-?\d*\.?\d+)/g)) corners.push([Number(pair[1]), Number(pair[2])]);
    }
    for (const [px, py] of corners) {
      const [tx, ty] = applyMatrix(ownMatrix, px, py);
      if (tx < shapeMinX) shapeMinX = tx;
      if (ty < shapeMinY) shapeMinY = ty;
      if (tx > shapeMaxX) shapeMaxX = tx;
      if (ty > shapeMaxY) shapeMaxY = ty;
    }
    if (shapeMinX === Infinity) continue;
    // Anything that does not touch the canvas at all is simply off-screen. A shape
    // that spans a whole axis or covers the entire canvas is a backdrop band (sky,
    // grass, road); cutting those at the edge is intended, so they are ignored too.
    const visible = shapeMaxX > box[0] && shapeMinX < box[0] + box[2] && shapeMaxY > box[1] && shapeMinY < box[1] + box[3];
    if (!visible) continue;
    sawShape = true;
    const bleedsAcross = (shapeMinX < box[0] && shapeMaxX > box[0] + box[2]) || (shapeMinY < box[1] && shapeMaxY > box[1] + box[3]);
    const coversCanvas = shapeMinX <= box[0] && shapeMaxX >= box[0] + box[2] && shapeMinY <= box[1] && shapeMaxY >= box[1] + box[3];
    if (bleedsAcross || coversCanvas) continue;
    // A shape that is almost entirely on canvas only loses a sliver; halos, glows
    // and soft shadows routinely graze the edge without looking cut off.
    const innerX = Math.max(0, Math.min(shapeMaxX, box[0] + box[2]) - Math.max(shapeMinX, box[0]));
    const innerY = Math.max(0, Math.min(shapeMaxY, box[1] + box[3]) - Math.max(shapeMinY, box[1]));
    const area = (shapeMaxX - shapeMinX) * (shapeMaxY - shapeMinY);
    if (!(area > 0) || (innerX * innerY) / area > 0.75) continue;
    // A clipped sliver only reads as "cut off" when it is big enough to be part of
    // the subject: road dashes, distant trees and specks sitting outside the frame
    // are invisible either way, so they must not drive the number.
    if (area < box[2] * box[3] * 0.005) continue;
    push(shapeMinX, shapeMinY);
    push(shapeMaxX, shapeMaxY);
  }
  if (minX === Infinity) return sawShape ? 0 : null;
  const overX = Math.max(0, box[0] - minX) + Math.max(0, maxX - (box[0] + box[2]));
  const overY = Math.max(0, box[1] - minY) + Math.max(0, maxY - (box[1] + box[3]));
  const pct = Math.max((overX / box[2]) * 100, (overY / box[3]) * 100);
  if (!Number.isFinite(pct) || pct > 300) return null;
  return Math.round(pct * 10) / 10;
}

export function sanitizeArtifact(text, options = {}) {
  let html = stripFence(text);
  if (!/<svg[\s>]/i.test(html)) throw new Error('模型回复中没有 SVG');
  html = html
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|iframe|object|embed|foreignObject|frame|frameset|portal)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|iframe|object|embed|foreignObject|link|base|frame|frameset|portal)\b[^>]*\/?\s*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '')
    .replace(/<image\b[^>]*\/?\s*>/gi, '')
    .replace(/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/\b(xlink:href|href|src|srcset|poster|action|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (match, name, dq, sq, bare) => {
      const value = (dq ?? sq ?? bare ?? '').trim();
      return /href$/i.test(name) && value.startsWith('#') ? ` ${name}="${value}"` : '';
    });
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_m, open, css, close) => `${open}${cleanCss(css)}${close}`);
  html = html.replace(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (_m, dq, sq) => {
    const cleaned = cleanCss(dq ?? sq ?? '').trim().replace(/"/g, '&quot;');
    return cleaned ? ` style="${cleaned}"` : '';
  });
  html = /<html[\s>]/i.test(html) ? (/<!doctype/i.test(html) ? html : `<!doctype html>${html}`) : htmlShell(html);
  // Keep the whole drawing visible in the preview: a model that picks "slice" would
  // otherwise have its subject cropped by the preview frame.
  html = html.replace(/(<svg\b[^>]*?)\spreserveAspectRatio\s*=\s*(?:"[^"]*"|'[^']*')/i, '$1 preserveAspectRatio="xMidYMid meet"');
  const probe = html.replace(/xmlns(?::[\w-]+)?\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
  const refs = [...probe.matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
    .map((match) => (match[1] ?? match[2] ?? match[3] ?? '').trim());
  const urls = [...probe.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)]
    .map((match) => (match[1] ?? match[2] ?? match[3] ?? '').trim());
  if (refs.some((value) => !value.startsWith('#')) || urls.some((value) => !value.startsWith('#')) || /@import/i.test(probe)) {
    throw new Error('产物引用了外部资源');
  }
  const bytes = Buffer.byteLength(html, 'utf8');
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : HTML_MAX_BYTES;
  if (bytes > maxBytes) throw new Error(`产物超过 ${maxBytes} 字节（实际 ${bytes} 字节）`);
  const elementCount = (html.match(/<[A-Za-z][^>]*>/g) || []).length;
  const animationCount = (html.match(/<(?:animate|animateMotion|animateTransform|set)\b/gi) || []).length;
  const cssAnimationCount = (html.match(/@keyframes\b/gi) || []).length;
  return {
    html,
    bytes,
    elementCount,
    animationCount,
    cssAnimationCount,
    colorCount: countColors(html),
    overflowPct: drawingOverflow(html),
    external: false,
  };
}

export async function probeModel(llm, input, signal) {
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!provider || !model) throw new Error('provider 和 model 不能为空');
  const type = ['svg', 'custom-svg', 'svg-html'].includes(input.type) ? input.type : 'connection';
  const isSvg = type === 'svg' || type === 'custom-svg';
  const isHtml = type === 'svg-html';
  const isDrawing = isSvg || isHtml;
  const customPrompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const quick = type === 'custom-svg' && input.quick !== false;
  if (type === 'custom-svg' && !customPrompt) throw new Error('自定义 SVG 提示词不能为空');
  if (customPrompt.length > 4000) throw new Error('自定义 SVG 提示词不能超过 4000 个字符');
  const timeoutMs = Math.max(3000, Math.min(isDrawing ? 600000 : 120000, Number(input.timeoutMs) || (isDrawing ? SVG_TIMEOUT : DEFAULT_TIMEOUT)));
  const maxTokens = Math.max(1, Math.min(isHtml ? HTML_MAX_TOKENS : isSvg ? SVG_MAX_TOKENS : 512, Number(input.maxTokens) || (type === 'custom-svg' && quick ? 4096 : isHtml ? HTML_MAX_TOKENS : isSvg ? SVG_MAX_TOKENS : DEFAULT_MAX_TOKENS)));
  const prompt = type === 'custom-svg' ? `${quick ? CUSTOM_SVG_QUICK_CONTRACT : CUSTOM_SVG_CONTRACT}${customPrompt}`
    : type === 'svg-html' ? `${HTML_CONTRACT}${customPrompt || HTML_BRIEF}`
      : type === 'svg' ? SVG_PROMPT : PROMPT;
  const startedAt = Date.now();
  const started = performance.now();
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('测试已停止'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`${isSvg ? 'SVG 检测' : isHtml ? '绘图检测' : '连接测试'}超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
  let firstTokenMs;
  let reply = '';
  let reasoning = '';
  let usage;
  let failure;
  let finishKind;
  try {
    const stream = llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      if (firstTokenMs === undefined && ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text || chunk.type === 'tool-call-delta')) {
        firstTokenMs = Math.round(performance.now() - started);
      }
      if (chunk.type === 'text-delta') reply += chunk.text;
      if (chunk.type === 'reasoning-delta') reasoning += chunk.text;
      if (chunk.type === 'usage') usage = chunk.usage;
      if (chunk.type === 'finish') {
        finishKind = chunk.reason?.kind;
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') failure = chunk.reason.failure;
      }
    }
    if (failure) {
      return {
        ok: false, provider, model, startedAt, elapsedMs: Math.round(performance.now() - started),
        firstTokenMs, mode: 'stream', code: failure.code || (finishKind === 'aborted' ? 'ABORTED' : 'UNKNOWN'),
        status: failure.status, message: redact(failure.message || '模型请求失败'), reply: reply.slice(0, 1000), usage,
      };
    }
    if (!['stop', 'tool-calls', 'max-tokens'].includes(finishKind)) {
      return {
        ok: false, provider, model, startedAt, elapsedMs: Math.round(performance.now() - started), firstTokenMs,
        mode: 'stream', code: 'INCOMPLETE_STREAM', message: `流未正常结束（${finishKind || '无 finish'}）`, reply: reply.slice(0, 1000), usage,
      };
    }
    const result = {
      ok: true, type, quick: type === 'custom-svg' ? quick : undefined, provider, model, startedAt, elapsedMs: Math.round(performance.now() - started), firstTokenMs,
      mode: 'stream', reply: reply.trim().slice(0, isDrawing ? 4000 : 1000), reasoning: reasoning.trim().slice(0, 1000), usage,
      exactReply: isDrawing ? undefined : reply.trim().toUpperCase() === 'OK',
      request: { provider, model, quick: type === 'custom-svg' ? quick : undefined, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens, stream: true },
    };
    if (isDrawing && finishKind === 'max-tokens' && !reply.trim()) {
      result.ok = false;
      result.code = 'OUTPUT_TRUNCATED';
      result.message = `输出配额耗尽（max-tokens ${maxTokens}），思考占满了生成预算，没有产出图形`;
      return result;
    }
    if (isHtml) {
      try {
        const { html, bytes, elementCount, animationCount, cssAnimationCount, colorCount, overflowPct, external } = sanitizeArtifact(reply);
        Object.assign(result, {
          html, htmlBytes: bytes, elementCount, animationCount, cssAnimationCount, colorCount, overflowPct, external,
          animated: animationCount + cssAnimationCount > 0,
        });
        if (!customPrompt && !result.animated) {
          result.ok = false;
          result.code = 'STATIC_DRAWING';
          result.message = '模型返回的产物没有动画';
        }
      } catch (error) {
        const text = textOf(error);
        result.ok = false;
        result.code = /外部资源/.test(text) ? 'EXTERNAL_RESOURCE' : /超过/.test(text) ? 'ARTIFACT_LIMIT_EXCEEDED' : 'INVALID_ARTIFACT';
        result.message = redact(text);
      }
    }
    if (isSvg) {
      try {
        const { svg, bytes, elementCount, animationCount } = sanitizeSvg(reply, type === 'custom-svg' && quick ? CUSTOM_SVG_QUICK_LIMITS : {});
        result.svg = svg;
        result.svgBytes = bytes;
        result.elementCount = elementCount;
        result.animationCount = animationCount;
        if (type === 'svg' && !animationCount) {
          result.ok = false;
          result.code = 'STATIC_SVG';
          result.message = '模型返回的 SVG 没有原生动画';
        }
      } catch (error) {
        result.ok = false;
        result.code = quick && /超过/.test(textOf(error)) ? 'SVG_LIMIT_EXCEEDED' : 'INVALID_SVG';
        result.message = redact(textOf(error));
      }
    }
    return result;
  } catch (error) {
    return {
      ok: false, provider, model, startedAt, elapsedMs: Math.round(performance.now() - started), firstTokenMs,
      mode: 'stream', code: error?.code || (controller.signal.aborted ? 'TIMEOUT' : 'REQUEST_ERROR'),
      status: error?.status, message: redact(textOf(error)), reply: reply.slice(0, 1000), usage,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

const activeTests = new Map();
const runTimes = new Map();
const MAX_RUN_HISTORY = 1000;

function beginRun(runId) {
  const now = Date.now();
  if (runTimes.size >= MAX_RUN_HISTORY) {
    const cutoff = now - 10 * 60 * 1000;
    for (const [id, time] of runTimes) {
      if (time < cutoff || runTimes.size >= MAX_RUN_HISTORY) runTimes.delete(id);
      if (runTimes.size < MAX_RUN_HISTORY) break;
    }
  }
  runTimes.set(runId, now);
  activeTests.get(runId)?.abort(new Error('已被新的测试取代'));
  const controller = new AbortController();
  activeTests.set(runId, controller);
  return controller;
}

function route(path, handler) {
  return {
    kind: 'exact', path,
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      try { await handler(req, res); } catch (error) {
        writeJson(res, 200, { ok: false, code: error?.code || 'PLUGIN_ERROR', message: redact(textOf(error)) });
      }
    },
  };
}

export function apply(ctx) {
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register(route(`${API}/catalog`, async (_req, res) => {
        const catalog = await readCatalog(ctx.llm);
        writeJson(res, 200, { ok: true, ...catalog });
      })),
      ctx.webServer.register(route(`${API}/test`, async (req, res) => {
        const body = await readJson(req);
        const runId = typeof body.runId === 'string' ? body.runId.slice(0, 100) : '';
        const controller = runId ? beginRun(runId) : new AbortController();
        try {
          const result = await probeModel(ctx.llm, body, controller.signal);
          writeJson(res, 200, result);
        } finally {
          if (runId && activeTests.get(runId) === controller) activeTests.delete(runId);
        }
      })),
      ctx.webServer.register(route(`${API}/fingerprint`, async (req, res) => {
        const body = await readJson(req);
        const runId = typeof body.runId === 'string' ? body.runId.slice(0, 100) : '';
        const controller = runId ? beginRun(runId) : new AbortController();
        try {
          const result = await fingerprintModel(ctx.llm, body, controller.signal);
          writeJson(res, 200, result);
        } finally {
          if (runId && activeTests.get(runId) === controller) activeTests.delete(runId);
        }
      })),
      ctx.webServer.register(route(`${API}/intelligence`, async (req, res) => {
        const body = await readJson(req);
        const runId = typeof body.runId === 'string' ? body.runId.slice(0, 100) : '';
        const controller = runId ? beginRun(runId) : new AbortController();
        try {
          const result = await intelligenceModel(ctx.llm, body, controller.signal);
          writeJson(res, 200, result);
        } finally {
          if (runId && activeTests.get(runId) === controller) activeTests.delete(runId);
        }
      })),
      ctx.webServer.register(route(`${API}/stop`, async (req, res) => {
        const body = await readJson(req);
        const ids = [...new Set([body.runId, ...(Array.isArray(body.runIds) ? body.runIds : [])].filter((id) => typeof id === 'string' && runTimes.has(id)))];
        let stopped = 0;
        for (const runId of ids) {
          runTimes.delete(runId);
          const controller = activeTests.get(runId);
          activeTests.delete(runId);
          if (!controller) continue;
          stopped += 1;
          controller.abort(new Error('测试已停止'));
        }
        writeJson(res, 200, { ok: true, stopped });
      })),
    ];
    return () => {
      for (const controller of activeTests.values()) controller.abort(new Error('插件正在重新加载'));
      activeTests.clear();
      runTimes.clear();
      for (const dispose of disposers.reverse()) dispose();
    };
  }, 'dsh-model-probe: routes');
}
