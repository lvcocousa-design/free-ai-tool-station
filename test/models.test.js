// test/models.test.js — 模型配置单元测试（lib/models.js + lib/models.json）
//
// 断言的值须与已知正确的模型 id 一致（groq/zhipu 的对话模型、cloudflare
// 的各能力模型、siliconflow 的各能力模型、elevenlabs 的 premade 音色）；
// 供应商与路由的模型常量均由此配置派生，这些断言即是“默认值/模型 id
// 未被改错”的防线。测试只读临时文件，不碰项目 data/。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeTempDir } = require('./helpers');
const models = require('../lib/models');

test('配置加载成功：7 项能力齐全', () => {
  const all = models.getAll();
  assert.deepEqual(
    Object.keys(all).sort(),
    ['chat', 'embed', 'image', 'stt', 'translate', 'tts', 'vision'],
  );
});

test('对话默认值与模型 id 与供应商文件一致', () => {
  assert.equal(models.getDefaultModel('chat', 'zhipu'), 'glm-4.7-flash');
  assert.equal(models.getDefaultModel('chat', 'groq'), 'openai/gpt-oss-120b');
  assert.equal(
    models.getDefaultModel('chat', 'cloudflare'),
    '@cf/meta/llama-3.1-8b-instruct-fp8',
  );
  assert.deepEqual(
    models.getModels('chat', 'zhipu').map((m) => m.id),
    ['glm-4.7-flash', 'glm-4.5-flash'],
  );
  assert.deepEqual(
    models.getModels('chat', 'groq').map((m) => m.id),
    ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
  );
  assert.deepEqual(
    models.getModels('chat', 'cloudflare').map((m) => m.id),
    ['@cf/meta/llama-3.1-8b-instruct-fp8'],
  );
  // 下拉 label 与原前端 CHAT_MODELS 一致
  assert.deepEqual(
    models.getModels('chat', 'groq').map((m) => m.label),
    ['gpt-oss-120b', 'gpt-oss-20b', 'Qwen3 8-27b'],
  );
});

test('Gemini 模型配置：对话与识图默认值与模型 id 一致', () => {
  assert.equal(models.getDefaultModel('chat', 'gemini'), 'gemini-3.8-flash');
  assert.deepEqual(
    models.getModels('chat', 'gemini').map((m) => m.id),
    ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],
  );
  assert.deepEqual(
    models.getModels('chat', 'gemini').map((m) => m.label),
    ['Gemini 3.8 Flash', 'Gemini 3.5 Flash-Lite'],
  );
  assert.equal(models.getDefaultModel('vision', 'gemini'), 'gemini-3.8-flash');
  assert.deepEqual(
    models.getModels('vision', 'gemini').map((m) => m.id),
    ['gemini-3.8-flash'],
  );
  assert.equal(models.isSupported('chat', 'gemini', 'gemini-3.5-flash-lite'), true);
  assert.equal(models.isSupported('chat', 'gemini', 'gemini-2.5-flash'), false);
});

test('NVIDIA NIM 模型配置：对话默认值与 9 个模型 id 一致', () => {
  assert.equal(models.getDefaultModel('chat', 'nvidia'), 'z-ai/glm-5.3-flash');
  assert.deepEqual(
    models.getModels('chat', 'nvidia').map((m) => m.id),
    [
      'z-ai/glm-5.3-flash',
      'moonshotai/kimi-k3.1-pro',
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'minimaxai/minimax-m3.1-flash',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
      'mistralai/mistral-large-4-1t-a52b',
      'stepfun-ai/step-5-preview',
      'google/gemma-4-31b-it',
      'meta/muse-glimmer-30b',
    ],
  );
  assert.deepEqual(
    models.getModels('chat', 'nvidia').map((m) => m.label),
    [
      'GLM-5.3-Flash',
      'Kimi K3.1 Pro',
      'Nemotron 3.5 Lightning 30B',
      'MiniMax M3.1 Flash',
      'Nemotron 3 Nano Omni 30B Reasoning',
      'Mistral Large 4',
      'Step-5 Preview',
      'Gemma 4 31B',
      'Muse Glimmer 30B',
    ],
  );
  assert.equal(models.isSupported('chat', 'nvidia', 'z-ai/glm-5.3-flash'), true);
  assert.equal(models.isSupported('chat', 'nvidia', 'moonshotai/kimi-k3.1-pro'), true);
  assert.equal(models.isSupported('chat', 'nvidia', 'openai/gpt-oss-120b'), false);
});

test('识图/出图/翻译/语音/向量默认值与模型 id 一致', () => {
  assert.equal(models.getDefaultModel('vision', 'zhipu'), 'glm-4.6v-flash');
  assert.equal(
    models.getDefaultModel('vision', 'siliconflow'),
    'PaddlePaddle/PaddleOCR-VL-1.5',
  );
  assert.equal(
    models.getDefaultModel('image', 'cloudflare'),
    '@cf/black-forest-labs/flux-1-schnell',
  );
  assert.equal(models.getDefaultModel('translate', 'cloudflare'), '@cf/meta/m2m100-1.2b');
  assert.equal(models.getDefaultModel('translate', 'siliconflow'), 'tencent/Hunyuan-MT-7B');
  assert.equal(models.getDefaultModel('tts', 'cloudflare'), '@cf/myshell-ai/melotts');
  assert.equal(models.getDefaultModel('stt', 'groq'), 'whisper-large-v3-turbo');
  assert.equal(
    models.getDefaultModel('stt', 'cloudflare'),
    '@cf/openai/whisper-large-v3-turbo',
  );
  assert.equal(models.getDefaultModel('stt', 'siliconflow'), 'FunAudioLLM/SenseVoiceSmall');
  assert.equal(models.getDefaultModel('embed', 'cloudflare'), '@cf/baai/bge-m3');
  assert.equal(models.getDefaultModel('embed', 'siliconflow'), 'BAAI/bge-m3');
});

test('isSupported：正反用例', () => {
  assert.equal(models.isSupported('chat', 'zhipu', 'glm-4.7-flash'), true);
  assert.equal(models.isSupported('chat', 'zhipu', 'glm-4.5-flash'), true);
  assert.equal(models.isSupported('chat', 'groq', 'qwen/qwen3.8-27b'), true);
  assert.equal(models.isSupported('image', 'cloudflare', '@cf/black-forest-labs/flux-1-schnell'), true);
  // TTS 音色 id 也算支持
  assert.equal(models.isSupported('tts', 'elevenlabs', 'EXAVITQu4vr4xnSDxMaL'), true);
  // 不存在的模型 / 供应商 / 能力 → false，不抛错
  assert.equal(models.isSupported('chat', 'zhipu', 'glm-4-flash'), false);
  assert.equal(models.isSupported('chat', 'groq', 'glm-4.7-flash'), false);
  assert.equal(models.isSupported('chat', 'deepl', 'glm-4.7-flash'), false);
  assert.equal(models.isSupported('music', 'elevenlabs', 'whatever'), false);
  assert.equal(models.isSupported('chat', 'zhipu', undefined), false);
});

test('未知能力/供应商时查询安全返回空值，不抛错', () => {
  assert.deepEqual(models.getModels('chat', 'deepl'), []);
  assert.deepEqual(models.getModels('music', 'elevenlabs'), []);
  assert.equal(models.getDefaultModel('chat', 'deepl'), undefined);
  assert.equal(models.getDefaultModel('music', 'elevenlabs'), undefined);
  assert.deepEqual(models.getVoices('cloudflare'), []);
  assert.deepEqual(models.getVoices('unknown'), []);
});

test('getVoices：5 个 premade 音色，默认 Sarah', () => {
  const voices = models.getVoices('elevenlabs');
  assert.equal(voices.length, 5);
  assert.deepEqual(
    voices.map((v) => v.label),
    ['Sarah', 'Alice', 'Adam', 'Bella', 'George'],
  );
  assert.deepEqual(
    voices.map((v) => v.id),
    [
      'EXAVITQu4vr4xnSDxMaL',
      'Xb7hH8MSUJpSbSDYk0k2',
      'pNInz6obpgDQGcFmaJgB',
      'hpp4J3VqNfWAUOO0d1Us',
      'JBFqnCBsd6RMkjVDRZzb',
    ],
  );
  assert.equal(models.getDefaultModel('tts', 'elevenlabs'), 'EXAVITQu4vr4xnSDxMaL');
  assert.equal(voices[0].label, 'Sarah');
});

test('getAll / getModels 返回深拷贝，调用方改动不污染内部配置', () => {
  const all = models.getAll();
  all.chat.zhipu.default = '被改坏了';
  all.chat.zhipu.models.push({ id: 'fake-model', label: '假模型' });
  assert.equal(models.getDefaultModel('chat', 'zhipu'), 'glm-4.7-flash');
  assert.equal(models.isSupported('chat', 'zhipu', 'fake-model'), false);

  const list = models.getModels('chat', 'groq');
  list[0].id = '被改坏了';
  assert.equal(models.getModels('chat', 'groq')[0].id, 'openai/gpt-oss-120b');
});

test('非法配置抛清晰中文错误：文件缺失', (t) => {
  const dir = makeTempDir(t);
  assert.throws(
    () => models.loadConfig(path.join(dir, '不存在的配置.json')),
    /模型配置文件缺失/,
  );
});

test('非法配置抛清晰中文错误：JSON 格式错误', (t) => {
  const dir = makeTempDir(t);
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{ 不是合法 JSON');
  assert.throws(
    () => models.loadConfig(file),
    /模型配置文件格式错误.*不是合法 JSON/,
  );
});

test('非法配置抛清晰中文错误：default 不在列表中', (t) => {
  const dir = makeTempDir(t);
  const file = path.join(dir, 'bad-default.json');
  fs.writeFileSync(file, JSON.stringify({
    chat: { zhipu: { default: '不存在的模型', models: [{ id: 'glm-4.7-flash', label: 'GLM' }] } },
  }));
  assert.throws(
    () => models.loadConfig(file),
    /chat\.zhipu.*default.*不在 models 列表中/,
  );
});

test('非法配置抛清晰中文错误：缺 default / 空列表 / 缺 label', (t) => {
  const dir = makeTempDir(t);
  const cases = [
    [{ chat: { zhipu: { models: [{ id: 'a', label: 'A' }] } } }, /chat\.zhipu.*缺少 default/],
    [{ chat: { zhipu: { default: 'a', models: [] } } }, /chat\.zhipu.*缺少非空的 models/],
    [{ chat: { zhipu: { default: 'a', models: [{ id: 'a' }] } } }, /必须有非空的 id 和 label/],
    [{ chat: '不是对象' }, /chat.*必须是对象/],
    [[], /顶层必须是对象/],
  ];
  cases.forEach(([badConfig, pattern], i) => {
    const file = path.join(dir, `bad-${i}.json`);
    fs.writeFileSync(file, JSON.stringify(badConfig));
    assert.throws(() => models.loadConfig(file), pattern);
  });
});

test('合法配置可正常加载（loadConfig 往返）', (t) => {
  const dir = makeTempDir(t);
  const file = path.join(dir, 'ok.json');
  const okConfig = {
    chat: { demo: { default: 'm1', models: [{ id: 'm1', label: 'M1' }] } },
    tts: { demo: { default: 'v1', voices: [{ id: 'v1', label: 'V1' }] } },
  };
  fs.writeFileSync(file, JSON.stringify(okConfig));
  assert.deepEqual(models.loadConfig(file), okConfig);
});
