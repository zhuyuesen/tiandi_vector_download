/**
 * 把已下载的 .pbf 瓦片原地转成 gzip 压缩（文件名、扩展名均不变）
 *
 * 与海图瓦片统一约定：磁盘上的 .pbf 文件本身就是 gzip 字节（魔数 1f 8b），
 * 由瓦片服务返回 Content-Encoding: gzip，浏览器收到后自动解压。
 *
 * 说明：
 *   - 可重复执行，已是 gzip 的瓦片会跳过；
 *   - 先写 .tmp 再原子重命名，中断不会产生残缺文件；
 *   - 只处理 config.outputDir 下的 tiles/，不影响 sprite / fonts / style.json。
 *
 * 用法：node gzip-tiles.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const config = require('./config');

const CONCURRENCY = 16;      // 并发处理文件数
const PROGRESS_EVERY = 20000; // 每处理多少个文件打印一次进度

function isGzip(buf) {
  return buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b;
}

// 递归遍历目录，逐条产出 .pbf 文件路径（不一次性收集 40 万个路径）
async function* walkPbf(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkPbf(p);
    else if (e.isFile() && e.name.endsWith('.pbf')) yield p;
  }
}

async function main() {
  const tilesDir = path.join(path.resolve(config.outputDir), 'tiles');
  if (!fs.existsSync(tilesDir)) throw new Error(`瓦片目录不存在：${tilesDir}`);

  console.log('======================================');
  console.log(' 已下载瓦片转 gzip（原地，保留 .pbf 文件名）');
  console.log('======================================');
  console.log(`瓦片目录: ${tilesDir}`);
  console.log(`并发: ${CONCURRENCY}  压缩级别: 9`);

  const stats = { total: 0, converted: 0, skipped: 0, failed: 0, before: 0, after: 0 };
  const startTime = Date.now();
  const iter = walkPbf(tilesDir);

  async function worker() {
    for (;;) {
      const { value: file, done } = await iter.next();
      if (done) return;
      stats.total++;

      try {
        const raw = await fs.promises.readFile(file);
        if (raw.length === 0 || isGzip(raw)) {
          stats.skipped++;
        } else {
          const gz = zlib.gzipSync(raw, { level: zlib.constants.Z_BEST_COMPRESSION });
          const tmp = file + '.tmp';
          await fs.promises.writeFile(tmp, gz);
          await fs.promises.rename(tmp, file);
          stats.converted++;
          stats.before += raw.length;
          stats.after += gz.length;
        }
      } catch (err) {
        stats.failed++;
      }

      if (stats.total % PROGRESS_EVERY === 0) {
        const sec = ((Date.now() - startTime) / 1000).toFixed(0);
        process.stdout.write(
          `\r   已扫描 ${stats.total.toLocaleString('en-US')}  转换 ${stats.converted.toLocaleString('en-US')}  ` +
          `跳过 ${stats.skipped.toLocaleString('en-US')}  失败 ${stats.failed}  ${sec}s   `
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\r'.padEnd(2) + ' '.repeat(100) + '\r');

  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  const ratio = stats.before > 0 ? ((stats.after / stats.before) * 100).toFixed(1) : '-';
  const sec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(
    `完成：扫描 ${stats.total.toLocaleString('en-US')}，转换 ${stats.converted.toLocaleString('en-US')}，` +
    `跳过 ${stats.skipped.toLocaleString('en-US')}，失败 ${stats.failed}，耗时 ${sec}s`
  );
  if (stats.converted > 0) {
    console.log(
      `体积：${mb(stats.before)} MB → ${mb(stats.after)} MB（${ratio}%），节省 ${mb(stats.before - stats.after)} MB`
    );
  }
  if (stats.failed > 0) {
    console.log('⚠ 有文件转换失败，重新执行本脚本会自动重试（已成功的不受影响）');
  }
}

main().catch((err) => {
  console.error('\n执行出错：', err.message);
  process.exit(1);
});
