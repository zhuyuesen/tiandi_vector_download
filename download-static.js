/**
 * 天地图普通地图矢量瓦片 - 离线静态资源脚本
 *
 * 下载 style.json 依赖的 sprite（图标）和 glyphs（字体），
 * 并把 style.json 中的 sprite/glyphs 地址改写为本地相对路径，实现完全离线渲染。
 *
 * 用法：
 *   1. 先运行 node download.js（下载瓦片并生成 style.json）
 *   2. 再运行 node download-static.js（下载图标/字体并改写 style.json）
 *   3. 用 http-server 或 nginx 托管部署根目录（默认 dist）即可离线访问
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('./config');

// ---------- 通用下载（带重试） ----------

function download(url, dest, retries = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: config.headers, agent: false }, (res) => {
      if (res.statusCode === 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          fs.writeFile(dest, Buffer.concat(chunks), (err) =>
            err ? reject(err) : resolve(chunks.reduce((s, c) => s + c.length, 0))
          );
        });
      } else {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
      }
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  }).catch((err) => {
    if (retries > 0) {
      return new Promise((r) => setTimeout(r, 1000 * (4 - retries))).then(() =>
        download(url, dest, retries - 1)
      );
    }
    throw err;
  });
}

// ---------- 默认 glyphs 字符范围（256 一组） ----------

function defaultGlyphRanges() {
  const ranges = [];
  // 基础拉丁及扩展（U+0000 – U+05FF）
  for (let s = 0; s <= 0x05ff; s += 256) ranges.push([s, s + 255]);
  // 中文基本区（U+4E00 – U+9FFF）
  for (let s = 0x4e00; s <= 0x9fff; s += 256) ranges.push([s, s + 255]);
  return ranges;
}

// ---------- 主流程 ----------

async function main() {
  const outDir = path.resolve(config.outputDir);
  const stylePath = path.join(outDir, 'style.json');
  if (!fs.existsSync(stylePath)) {
    throw new Error(`未找到 ${stylePath}，请先运行 node download.js 生成 style.json`);
  }
  const style = JSON.parse(fs.readFileSync(stylePath, 'utf8'));

  // 1. 下载 sprite（png.json / png.png / png@2x.json / png@2x.png）
  const spriteBase = config.style.sprite.replace(/\/+$/, '');
  const spriteDir = path.join(outDir, 'sprite');
  fs.mkdirSync(spriteDir, { recursive: true });
  const spriteSuffixes = ['.json', '.png', '@2x.json', '@2x.png'];
  for (const suffix of spriteSuffixes) {
    const url = spriteBase + suffix;
    const dest = path.join(spriteDir, 'png' + suffix);
    if (fs.existsSync(dest)) {
      console.log(`sprite png${suffix} 已存在，跳过`);
      continue;
    }
    const size = await download(url, dest);
    console.log(`sprite png${suffix} -> ${size} 字节`);
  }

  // 2. 收集 style 中使用的字体栈
  const fontstacks = new Set();
  for (const layer of style.layers) {
    const tf = layer.layout && layer.layout['text-font'];
    if (Array.isArray(tf)) tf.forEach((f) => fontstacks.add(f));
  }
  console.log(`\n字体栈：${[...fontstacks].join(', ') || '(无)'}`);

  // 3. 下载 glyphs（先探测字体是否存在，跳过 CDN 上不存在的字体）
  const ranges =
    config.style.glyphRanges && config.style.glyphRanges.length
      ? config.style.glyphRanges
      : defaultGlyphRanges();
  const glyphDir = path.join(outDir, 'fonts');
  // URL 里的 fontstack 需 URL 编码（空格 -> %20）；本地目录名用原始字体名（含空格）
  const buildGlyphUrl = (fontstack, s, e) =>
    config.style.glyphs
      .replace('{fontstack}', encodeURIComponent(fontstack))
      .replace('{range}', `${s}-${e}`);

  const tasks = [];
  let skippedFonts = 0;
  for (const fontstack of fontstacks) {
    const dir = path.join(glyphDir, fontstack);
    fs.mkdirSync(dir, { recursive: true });

    // 先用 0-255 探测该字体在 CDN 上是否存在（已存在则跳过探测）
    const probePath = path.join(dir, '0-255.pbf');
    if (fs.existsSync(probePath)) {
      console.log(`字体「${fontstack}」已存在，跳过探测`);
    } else {
      try {
        await download(buildGlyphUrl(fontstack, 0, 255), probePath);
      } catch (err) {
        skippedFonts++;
        try {
          fs.rmdirSync(dir);
        } catch (_) {}
        console.log(`跳过字体「${fontstack}」（CDN 上不存在：${err.message}）`);
        continue;
      }
    }
    // 字体存在，加入其余字符范围
    for (const [s, e] of ranges) {
      if (s === 0 && e === 255) continue;
      tasks.push({ fontstack, s, e });
    }
  }

  console.log(
    `\n待下载 glyphs ${tasks.length} 个（可用字体 ${fontstacks.size - skippedFonts} 个，跳过 ${skippedFonts} 个）`
  );

  let done = 0;
  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;
  const queue = tasks.slice();

  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      const dest = path.join(glyphDir, t.fontstack, `${t.s}-${t.e}.pbf`);
      if (fs.existsSync(dest)) {
        skipCount++;
        done++;
        continue;
      }
      try {
        await download(buildGlyphUrl(t.fontstack, t.s, t.e), dest);
        okCount++;
      } catch (err) {
        failCount++;
        try {
          fs.unlinkSync(dest);
        } catch (_) {}
        console.error(`失败 ${t.fontstack} ${t.s}-${t.e}：${err.message}`);
      }
      done++;
      if (done % 50 === 0) {
        console.log(`进度 ${done}/${tasks.length}（成功 ${okCount}，跳过 ${skipCount}，失败 ${failCount}）`);
      }
    }
  }

  const workerCount = Math.min(config.concurrency, tasks.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  console.log(`\nglyphs 下载完成：成功 ${okCount}，跳过 ${skipCount}，失败 ${failCount}`);

  // 4. 改写 style.json 的 sprite / glyphs 为本地相对路径
  //    tileBaseUrl 是 URL 前缀，统一用正斜杠；留空 '' 表示部署根即站点根
  const base = String(config.style.tileBaseUrl || '').replace(/^\/+|\/+$/g, '');
  const prefix = base ? `${base}/` : '';
  style.sprite = `${prefix}sprite/png`;
  style.glyphs = `${prefix}fonts/{fontstack}/{range}.pbf`;
  fs.writeFileSync(stylePath, JSON.stringify(style));
  console.log(`\n已改写 style.json：`);
  console.log(`  sprite -> ${style.sprite}`);
  console.log(`  glyphs -> ${style.glyphs}`);
  console.log(`\n离线资源目录：${outDir}`);
  console.log(`  ${outDir}/sprite/  (图标)`);
  console.log(`  ${outDir}/fonts/   (字体)`);
  console.log(`\n现在用静态服务器托管 ${outDir} 目录即可完全离线渲染。`);
}

main().catch((err) => {
  console.error('\n执行出错：', err.message);
  process.exit(1);
});
