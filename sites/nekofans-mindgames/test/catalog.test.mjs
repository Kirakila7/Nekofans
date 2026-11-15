import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('catalog contains curated 《开源与抹除》 game and rules by A.kira', () => {
  const catalogPath = path.resolve(__dirname, '../app/catalog.ts');
  assert(fs.existsSync(catalogPath), 'catalog.ts must exist');
  const content = fs.readFileSync(catalogPath, 'utf8');

  // Verify categories
  assert(content.includes("'棋盘智斗'"), 'categories must include 棋盘智斗');
  assert(content.includes("'文字博弈'"), 'categories must include 文字博弈');
  assert(content.includes("'派对推理'"), 'categories must include 派对推理');

  // Verify game entry
  assert(content.includes("id: 'first-open-and-erase'"), 'must include first-open-and-erase entry');
  assert(content.includes("title: '开源与抹除'"), 'must include 开源与抹除 title');
  assert(content.includes("creator: 'A.kira'"), 'creator must be A.kira');

  // Verify rules
  assert(content.includes("id: 'rule-open-source'"), 'must include rule-open-source');
  assert(content.includes("title: '开源'"), 'must include 开源 rule');
  assert(content.includes("id: 'rule-erase'"), 'must include rule-erase');
  assert(content.includes("title: '抹除'"), 'must include 抹除 rule');
});

test('public assets required by the game showcase exist and are non-empty', () => {
  const assetsDir = path.resolve(__dirname, '../public/assets');
  const required = [
    'bigfish.webp', 'duel-concept.webp', 'host-poster.webp',
    'host.mp4', 'rules-poster.webp', 'rules.mp4',
    'workbench-poster.webp', 'workbench.mp4'
  ];
  for (const file of required) {
    const p = path.join(assetsDir, file);
    assert(fs.existsSync(p), `Asset ${file} must exist`);
    assert(fs.statSync(p).size > 0, `Asset ${file} must not be empty`);
  }
});
