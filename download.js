/**
 * 天地图普通地图矢量瓦片下载脚本
 *
 * 用法：node download.js
 * 依赖：better-sqlite3（仅用于断点续传进度记录）
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('./config');
const ProgressDB = require('./db-helper');

// ---------- 常量 ----------

const PROGRESS_DB = path.resolve(__dirname, './progress/progress.db');
const FINGERPRINT_KEY = 'configFingerprint';
const RETRY_LIMIT = 3;            // 单瓦片网络错误最大重试次数
const REQUEST_TIMEOUT_MS = 30000; // 单次请求超时（毫秒）
const PROGRESS_EVERY_MS = 300;    // 进度行刷新间隔（毫秒）

// ---------- 优雅退出 ----------

let shuttingDown = false;
let sigintCount = 0;

process.on('SIGINT', () => {
  sigintCount++;
  if (sigintCount >= 2) {
    console.log('\n强制退出');
    process.exit(1);
  }
  console.log('\n收到 Ctrl+C，完成当前列后退出（再按一次强制退出）');
  shuttingDown = true;
});
process.on('SIGTERM', () => { console.log('\n收到 SIGTERM，正在退出...'); shuttingDown = true; });
process.on('SIGHUP', () => { console.log('\n收到 SIGHUP，正在退出...'); shuttingDown = true; });

// ---------- 瓦片坐标换算（Web 墨卡托 XYZ，Y 轴自上而下） ----------

function lngToX(lng, z) {
  const n = 2 ** z;
  return Math.floor(((lng + 180) / 360) * n);
}

function latToY(lat, z) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
}

// ---------- pk 签名（从天地图官网前端 JS 逆向还原，已实测验证） ----------

function runLengthEncode(s) {
  let out = '';
  let prev = '';
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    const code = 3 * Number(s[i]);
    let last = out.length - 1;
    const ch = String.fromCharCode(97 + code);
    if (ch === prev) {
      run++;
      if (run === 1) last++;
      else if (run > 10) last--;
      out = out.slice(0, last) + run;
    } else {
      out += ch;
      prev = ch;
      run = 0;
    }
  }
  return out;
}

function calcPk(x, y, z) {
  let n = '';
  for (let a = z; a >= 0; a--) {
    const bit = 1 << a;
    let o = 0;
    if (x & bit) o |= 1;
    if (y & bit) o |= 2;
    n += o;
  }
  let o = n.split('').reverse().join('');
  const seq = '9876';
  for (let a = 0; a < seq.length; a++) {
    const idx = Number(seq[a]);
    if (idx >= o.length) continue;
    const v = 1 + Number(o[idx]);
    o = o.slice(0, idx) + v + o.slice(idx + 1);
  }
  return runLengthEncode(o);
}

function buildTileUrl(x, y, z, tk, sub) {
  const pk = calcPk(x, y, z);
  return `https://${sub}.tianditu.gov.cn/vts?t=vt&pk=${pk}&tk=${tk}&v=1.0`;
}

// ---------- 瓦片解密（天地图 vts 瓦片是加密的，需还原为标准 MVT） ----------
// 加密算法（从官网前端 JS 逆向）：字节取反 + Layer/Feature 字段编号重映射 + type/command 重映射

function readVarint(buf, pos) {
  let r = 0;
  let s = 0;
  while (true) {
    const c = buf[pos++];
    r |= (c & 0x7f) << s;
    if (!(c & 0x80)) break;
    s += 7;
  }
  return [r, pos];
}

// geometry 的 command 重映射：加密 2(MoveTo)→1, 3(LineTo)→2, 7(ClosePath) 不变
function remapCommands(buf, start, end) {
  let pos = start;
  while (pos < end) {
    const cmdStart = pos;
    const [v, p1] = readVarint(buf, pos);
    const cmd = v & 7;
    const count = v >> 3;
    let ncmd = cmd;
    if (cmd === 2) ncmd = 1;
    else if (cmd === 3) ncmd = 2;
    buf[cmdStart] = (buf[cmdStart] & 0xf8) | ncmd;
    pos = p1;
    if (cmd !== 7) {
      for (let i = 0; i < count * 2; i++) {
        const [, p2] = readVarint(buf, pos);
        pos = p2;
      }
    }
  }
}

// type 值重映射：加密 1(LineString)→2, 2(Polygon)→3, 4(Point)→1
function remapType(buf, start) {
  const v = buf[start];
  let nv = v;
  if (v === 1) nv = 2;
  else if (v === 2) nv = 3;
  else if (v === 4) nv = 1;
  if (nv !== v) buf[start] = nv;
}

// Feature 字段重映射：id 4→1, tags 3→2, type 2→3, geometry 1→4
function decryptFeature(buf, start, end) {
  let pos = start;
  while (pos < end) {
    const tagStart = pos;
    const [tag, p1] = readVarint(buf, pos);
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const [, p2] = readVarint(buf, p1);
      if (field === 4) buf[tagStart] = (1 << 3) | 0; // id
      else if (field === 2) {
        buf[tagStart] = (3 << 3) | 0; // type
        remapType(buf, p1);
      }
      pos = p2;
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, p1);
      if (field === 1) {
        buf[tagStart] = (4 << 3) | 2; // geometry
        remapCommands(buf, p2, p2 + len);
      } else if (field === 3) buf[tagStart] = (2 << 3) | 2; // tags
      pos = p2 + len;
    } else break;
  }
}

// Value 字段重映射：double 3→2、float 2→3（加密把 value 消息里的 double/float 字段号互换）
// 说明：Value 消息字段为 string=1、float=2、double=3、int=4、uint=5、sint=6、bool=7，
// 加密只互换 2(float)/3(double)，wire 类型保持不变；此处换回标准字段号。
function decryptValue(buf, start, end) {
  let pos = start;
  while (pos < end) {
    const tagStart = pos;
    const [tag, p1] = readVarint(buf, pos);
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 2) buf[tagStart] = (3 << 3) | wire; // 加密 double(2) → 标准(3)
    else if (field === 3) buf[tagStart] = (2 << 3) | wire; // 加密 float(3) → 标准(2)
    if (wire === 0) {
      const [, p2] = readVarint(buf, p1);
      pos = p2;
    } else if (wire === 1) {
      pos = p1 + 8; // double
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, p1);
      pos = p2 + len; // string
    } else if (wire === 5) {
      pos = p1 + 4; // float
    } else break;
  }
}

// Layer 字段重映射：name 2→1, features 1→2, keys 4→3, values 3→4
function decryptLayer(buf, start, end) {
  let pos = start;
  while (pos < end) {
    const tagStart = pos;
    const [tag, p1] = readVarint(buf, pos);
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const [, p2] = readVarint(buf, p1);
      pos = p2;
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, p1);
      let nf = field;
      if (field === 1) nf = 2;
      else if (field === 2) nf = 1;
      else if (field === 3) nf = 4;
      else if (field === 4) nf = 3;
      buf[tagStart] = (nf << 3) | 2;
      if (nf === 2) decryptFeature(buf, p2, p2 + len); // features
      else if (nf === 4) decryptValue(buf, p2, p2 + len); // values
      pos = p2 + len;
    } else break;
  }
}

function decryptTile(raw) {
  const buf = Buffer.from(raw);
  // 字节取反：索引 [1,2,3,4,99]
  for (const idx of [1, 2, 3, 4, 99]) if (idx < buf.length) buf[idx] = 255 - buf[idx];
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p1] = readVarint(buf, pos);
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 2) {
      const [len, p2] = readVarint(buf, p1);
      if (field === 3) decryptLayer(buf, p2, p2 + len); // layers
      pos = p2 + len;
    } else if (wire === 0) {
      const [, p2] = readVarint(buf, p1);
      pos = p2;
    } else break;
  }
  return buf;
}

// ---------- 下载 ----------

// 下载单个瓦片：200 解密后原子落盘；404 或空内容视为「空瓦片」；其余错误按 retries 重试
function downloadTile(url, filePath, retries = RETRY_LIMIT) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: config.headers, agent: false }, (res) => {
      if (res.statusCode === 200) {
        const chunks = [];
        const encrypt = res.headers['pragma']; // 响应头 Pragma=1 表示该瓦片已加密
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let data = Buffer.concat(chunks);
          if (encrypt === '1') data = decryptTile(data); // 还原为标准 MVT
          if (data.length === 0) return resolve({ status: 'empty' });

          // 先写 .tmp 再原子重命名，避免中断产生残缺文件
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          const tmp = filePath + '.tmp';
          fs.writeFile(tmp, data, (err) => {
            if (err) return reject(err);
            try {
              fs.renameSync(tmp, filePath);
              resolve({ status: 'ok', size: data.length });
            } catch (e) {
              try { fs.unlinkSync(tmp); } catch (_) {}
              reject(e);
            }
          });
        });
      } else if (res.statusCode === 404) {
        res.resume();
        resolve({ status: 'empty' });
      } else {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
      }
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
  }).catch((err) => {
    if (retries > 0) {
      return new Promise((r) => setTimeout(r, 1000 * (RETRY_LIMIT - retries + 1))).then(() =>
        downloadTile(url, filePath, retries - 1)
      );
    }
    throw err;
  });
}

// 多 tk 轮询：每个瓦片依次使用不同密钥，避免单个密钥调用超限
let tkCursor = 0;
function nextTk() {
  const tks = config.tks || [];
  return tks[tkCursor++ % tks.length];
}

// 子域自动回退：首选子域失败时依次尝试其余子域
async function downloadWithFallback(t, file) {
  const tk = nextTk();
  const primary = config.subdomains[(t.x + t.y) % config.subdomains.length];
  const subs = [primary, ...config.subdomains.filter((s) => s !== primary)];
  let lastErr;
  for (const sub of subs) {
    try {
      return await downloadTile(buildTileUrl(t.x, t.y, t.z, tk, sub), file);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---------- 并发池 ----------

// 以固定并发数消费迭代器，shouldStop() 返回 true 时提前终止所有 worker
async function runWithConcurrency(iter, concurrency, workerFn, shouldStop = null) {
  async function runOne() {
    while (true) {
      if (shouldStop && shouldStop()) return;
      const { value, done } = iter.next();
      if (done) return;
      await workerFn(value);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runOne));
}

// 生成 [yMin, yMax] 闭区间整数序列，供并发池消费
function* yRange(yMin, yMax) {
  for (let y = yMin; y <= yMax; y++) yield y;
}

// ---------- 进度格式化 ----------

function fmtEta(sec) {
  if (sec <= 0 || !isFinite(sec)) return '--';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

function fmtNum(n) {
  return n.toLocaleString('en-US');
}

// ---------- style.json 生成 ----------

function httpGetText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: config.headers }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`样式请求失败 HTTP ${res.statusCode}: ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      })
      .on('error', reject);
  });
}

async function generateStyle(outDir) {
  const outPath = path.join(outDir, 'style.json');
  if (fs.existsSync(outPath)) {
    console.log(`style.json 已存在，跳过生成（如需重新生成请删除后重跑）`);
    return;
  }

  const styles = [];
  for (const u of config.style.styleUrls) {
    styles.push(JSON.parse(await httpGetText(u)));
  }

  // 以第一个样式为基底，合并后续样式的 layers
  const merged = styles[0];
  for (let i = 1; i < styles.length; i++) {
    merged.layers = merged.layers.concat(styles[i].layers);
  }

  // 改写数据源瓦片地址：tileBaseUrl 是部署根目录的 URL 前缀（相对路径或完整 URL 均可，留空表示部署根即站点根）
  // 瓦片实际存放在 <部署根>/tiles/ 下，故地址需带 tiles/ 段
  const tileBase = String(config.style.tileBaseUrl || '').replace(/\/+$/, '');
  const tilePrefix = tileBase ? `${tileBase}/` : '';
  for (const key of Object.keys(merged.sources)) {
    const s = merged.sources[key];
    if (s.type === 'vector' && s.tiles) {
      s.tiles = [`${tilePrefix}tiles/{z}/{x}/{y}.pbf`];
    }
  }

  if (config.style.sprite) merged.sprite = config.style.sprite;
  if (config.style.glyphs) merged.glyphs = config.style.glyphs;

  fs.writeFileSync(outPath, JSON.stringify(merged));
  console.log(`已生成 style.json -> ${outPath}`);
}

// ---------- 主流程 ----------

// 按 bbox 与 zoom 范围估算瓦片总数（与任务生成逻辑一致，用于进度百分比与 ETA）
function countTiles(minLng, minLat, maxLng, maxLat, minZoom, maxZoom) {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const n = 2 ** z;
    const xMin = Math.max(0, lngToX(minLng, z));
    const xMax = Math.min(n - 1, lngToX(maxLng, z));
    const yMin = Math.max(0, latToY(maxLat, z)); // 上方（北）行号更小
    const yMax = Math.min(n - 1, latToY(minLat, z));
    total += (xMax - xMin + 1) * (yMax - yMin + 1);
  }
  return total;
}

// 下载配置指纹：范围/级别/输出目录变化时自动重置进度
function buildFingerprint() {
  return JSON.stringify({
    point1: config.point1,
    point2: config.point2,
    minZoom: config.minZoom,
    maxZoom: config.maxZoom,
    outputDir: path.resolve(config.outputDir),
  });
}

async function main() {
  if (!Array.isArray(config.tks) || config.tks.length === 0 ||
      config.tks.some((k) => typeof k !== 'string' || !k.trim() || k.includes('在这里'))) {
    throw new Error('请先在 config.js 中填入天地图开发者密钥 tk');
  }

  const [lng1, lat1] = config.point1;
  const [lng2, lat2] = config.point2;
  const minLng = Math.min(lng1, lng2);
  const maxLng = Math.max(lng1, lng2);
  const minLat = Math.min(lat1, lat2);
  const maxLat = Math.max(lat1, lat2);

  const outDir = path.resolve(config.outputDir);
  const tilesDir = path.join(outDir, 'tiles');
  fs.mkdirSync(tilesDir, { recursive: true });

  const totalTiles = countTiles(minLng, minLat, maxLng, maxLat, config.minZoom, config.maxZoom);

  // 打开进度库，配置变化时自动重置
  const db = new ProgressDB(PROGRESS_DB);
  const fp = buildFingerprint();
  if (db.getMeta(FINGERPRINT_KEY) !== fp) {
    console.log('检测到下载配置变化，已重置进度记录');
    db.resetProgress();
    db.setMeta(FINGERPRINT_KEY, fp);
  }

  console.log('======================================');
  console.log(' 天地图矢量瓦片下载（含解密）');
  console.log('======================================');
  console.log(`级别: ${config.minZoom}~${config.maxZoom}  瓦片总数: ${fmtNum(totalTiles)}  并发: ${config.concurrency}`);
  console.log(`输出目录: ${outDir}`);
  console.log(`进度DB: ${PROGRESS_DB}  已完成列: ${fmtNum(db.completedBatchCount())}  历史错误: ${db.errorCount()}`);
  console.log();

  // ---- Phase 1：重试历史错误瓦片 ----

  const errorTiles = db.getErrorTiles();
  let retryOk = 0, retryEmpty = 0, retryFail = 0;

  if (errorTiles.length > 0 && !shuttingDown) {
    console.log(`[Phase 1] 重试 ${errorTiles.length} 个历史错误瓦片...`);
    let retried = 0;
    const retryIter = errorTiles[Symbol.iterator]();

    await runWithConcurrency(retryIter, config.concurrency, async ({ z, x, y }) => {
      if (shuttingDown) return;
      const file = path.join(tilesDir, String(z), String(x), `${y}.pbf`);
      try {
        const result = await downloadWithFallback({ x, y, z }, file);
        db.removeError(z, x, y);
        result.status === 'ok' ? retryOk++ : retryEmpty++;
      } catch (_) {
        retryFail++;
      }
      retried++;
      process.stdout.write(
        `\r   重试: ${retried}/${errorTiles.length}  成功:${retryOk}  空:${retryEmpty}  仍失败:${retryFail}   `
      );
    }, () => shuttingDown);

    console.log(`\n  Phase 1 完成：解决 ${retryOk + retryEmpty} 个，仍失败 ${db.errorCount()} 个\n`);
  }

  // 本次重试后仍失败的瓦片放入 Set，Phase 2 中跳过（避免同一次运行重复请求）
  const stillErrorSet = new Set(
    db.getErrorTiles().map(({ z, x, y }) => `${z}:${x}:${y}`)
  );

  // ---- Phase 2：按 (z, x) 列批次正常下载 ----

  const stats = { ok: 0, empty: 0, skip: 0, error: 0, processed: 0 };
  const startTime = Date.now();
  let lastPrint = 0;

  const printProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastPrint < PROGRESS_EVERY_MS) return;
    lastPrint = now;

    const elapsed = (now - startTime) / 1000;
    const rate = elapsed > 0 ? stats.processed / elapsed : 0;
    const remaining = totalTiles - stats.processed;
    const etaSec = rate > 0 ? Math.round(remaining / rate) : Infinity;
    const pct = totalTiles > 0
      ? ((stats.processed / totalTiles) * 100).toFixed(1)
      : '0.0';

    process.stdout.write(
      `\r   ${pct}% [${fmtNum(stats.processed)}/${fmtNum(totalTiles)}] ` +
      `下载:${fmtNum(stats.ok)} 空:${fmtNum(stats.empty)} 跳过:${fmtNum(stats.skip)} 错误:${stats.error} ` +
      `速率:${rate.toFixed(0)}/s ETA:${fmtEta(etaSec)}    `
    );
  };

  for (let z = config.minZoom; z <= config.maxZoom && !shuttingDown; z++) {
    const n = 2 ** z;
    const xMin = Math.max(0, lngToX(minLng, z));
    const xMax = Math.min(n - 1, lngToX(maxLng, z));
    const yMin = Math.max(0, latToY(maxLat, z)); // 上方（北）行号更小
    const yMax = Math.min(n - 1, latToY(minLat, z));
    const colHeight = yMax - yMin + 1;

    for (let x = xMin; x <= xMax && !shuttingDown; x++) {
      // 已完成的整列直接跳过
      if (db.isBatchDone(z, x)) {
        stats.skip += colHeight;
        stats.processed += colHeight;
        printProgress();
        continue;
      }

      await runWithConcurrency(yRange(yMin, yMax), config.concurrency, async (y) => {
        if (shuttingDown) return;
        const file = path.join(tilesDir, String(z), String(x), `${y}.pbf`);

        // Phase 1 重试后仍失败的，本次跳过
        if (stillErrorSet.has(`${z}:${x}:${y}`)) {
          stats.error++;
          stats.processed++;
          printProgress();
          return;
        }

        // 文件已存在（非空）则跳过（续传）
        try {
          if (fs.statSync(file).size > 0) {
            stats.skip++;
            stats.processed++;
            printProgress();
            return;
          }
        } catch (_) {}

        try {
          const result = await downloadWithFallback({ x, y, z }, file);
          result.status === 'ok' ? stats.ok++ : stats.empty++;
        } catch (_) {
          stats.error++;
          db.addError(z, x, y);
        }
        stats.processed++;
        printProgress();
      }, () => shuttingDown);

      // 未中断时标记整列完成
      if (!shuttingDown) {
        db.markBatchDone(z, x);
      }
    }
  }

  printProgress(true);
  console.log();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `完成：下载 ${fmtNum(stats.ok + retryOk)}，空 ${fmtNum(stats.empty + retryEmpty)}，` +
    `跳过 ${fmtNum(stats.skip)}，错误 ${stats.error + retryFail}，耗时 ${elapsed}s`
  );

  if (shuttingDown) {
    console.log('⚠ 已中断，下次运行将从断点继续');
  }

  console.log(`瓦片目录：${tilesDir}`);
  db.close();

  if (config.generateStyle) {
    await generateStyle(outDir);
  }
}

main().catch((err) => {
  console.error('\n执行出错：', err.message);
  process.exit(1);
});
