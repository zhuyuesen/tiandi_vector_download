# 天地图普通地图矢量瓦片下载

下载天地图「普通地图」（矢量底图 vec + 矢量注记 cva）的矢量瓦片（MVT/PBF），并离线渲染到 `leaflet + @maplibre/maplibre-gl-leaflet`。

> 项目结论：天地图「普通地图」矢量瓦片走 `/vts` 端点，数据**不是**标准 MVT，而是做了加密混淆（动态 pk 签名 + PBF 结构加密）。本项目已完整逆向 pk 签名算法和解密算法，下载时自动解密为标准 MVT。

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 编辑 config.js：填入 tk、下载范围 point1/point2、级别 minZoom/maxZoom

# 3. 下载瓦片（自动解密为标准 MVT）并生成 style.json
node download.js

# 4.（可选，实现完全离线）下载图标和字体，并改写 style.json 为本地路径
node download-static.js

# 5. 在「项目根目录」启动静态服务器
python3 -m http.server 8080

# 6. 浏览器打开
# http://localhost:8080/index.html
```

---

## 一、目录结构

| 文件                 | 作用                                                                |
| -------------------- | ------------------------------------------------------------------- |
| `config.js`          | 配置文件（tk、范围、级别、输出目录等）                              |
| `download.js`        | 下载瓦片 + 自动解密 + 生成 style.json                               |
| `download-static.js` | 下载离线 sprite（图标）+ glyphs（字体），改写 style.json 为本地路径 |
| `index.html`         | 渲染测试页（leaflet + maplibre-gl-leaflet）                         |
| `参考.md`            | 参考文章分析（其中部分说法不准确，见文末）                          |

### 输出目录（部署根）结构

运行后 `dist/`（`config.outputDir`）下的结构如下，静态资源与瓦片分层存放：

```text
dist/                    # 部署根（用静态服务器托管此目录，或作为项目根下的子路径）
├── style.json           # 样式（指向本目录下的 tiles/sprite/fonts）
├── tiles/               # 瓦片（只放 {z}/{x}/{y}.pbf）
│   └── {z}/{x}/{y}.pbf
├── sprite/              # 图标
└── fonts/               # 字体（SDF 位图字形 .pbf）
    └── {fontstack}/{range}.pbf
```

说明：`style.json`、`sprite/`、`fonts/` 与瓦片 `tiles/` 平级分开存放，多批次下载（低层级全球 + 高层级局部）时不会重复下载静态资源；脚本对已存在的 `style.json` / sprite / glyphs 会自动跳过。

### 路径与跨平台说明

- **`config.outputDir`（文件系统路径）**：脚本内部统一用 `path.resolve` / `path.join` 处理，已兼容 Windows / macOS / Linux 的路径分隔符（`\` 与 `/`）。支持相对路径（相对脚本所在目录）和绝对路径。
  - 推荐写法（正斜杠，跨平台安全）：`./dist`、`/data/tiles`、`D:/data/tiles`
  - Windows 反斜杠写法需双反斜杠转义：`D:\\data\\tiles`
- **`config.style.tileBaseUrl`（URL 前缀）**：它写入 `style.json`，是 URL 路径而非文件系统路径，必须用正斜杠 `/`，与操作系统无关。留空 `''` 表示部署根即站点根目录（例如直接用静态服务器托管 `dist/`）。

---

## 二、原理说明

### 1. 瓦片端点

```
https://tile{0-7}.tianditu.gov.cn/vts?t=vt&pk={pk}&tk={tk}&v=1.0
```

- `tile0 ~ tile7`：子域轮询（部分子域可能不可用，脚本会自动回退）。
- `tk`：天地图开发者密钥，在 https://console.tianditu.gov.cn/ 申请。
- `pk`：动态签名，由瓦片坐标 `(x, y, z)` 实时计算，见下文。

### 2. 动态 pk 签名算法

`pk` 是根据瓦片坐标 `(x, y, z)` 计算的，不是固定值。算法（从官网前端 JS 逆向还原）：

```js
// 1. Morton/Z 序交织：从 z 到 0 逐位，x 的第 a 位放到 bit0，y 的第 a 位放到 bit1，得到一个 0~3 的数字串
let n = "";
for (let a = z; a >= 0; a--) {
  const bit = 1 << a;
  let o = 0;
  if (x & bit) o |= 1;
  if (y & bit) o |= 2;
  n += o;
}

// 2. 反转数字串
let o = n.split("").reverse().join("");

// 3. 对第 9/8/7/6 位（若存在）做 +1 处理
const seq = "9876";
for (let a = 0; a < seq.length; a++) {
  const idx = Number(seq[a]);
  if (idx >= o.length) continue;
  o = o.slice(0, idx) + (1 + Number(o[idx])) + o.slice(idx + 1);
}

// 4. 行程编码（每个数字 d 映射为字母 'a'+3*d，连续相同字母压缩为 字母+次数）
//    得到最终 pk 字符串，例如 pk(105,48,7) = "da1dgjgd"
```

完整实现见 `download.js` 里的 `calcPk` / `runLengthEncode`。

### 3. 瓦片数据加密与解密

瓦片响应头里 `Pragma: 1` 表示该瓦片已加密。加密在标准 MVT 基础上做了 6 层变换，解密需全部逆向还原：

| 变换                      | 说明                                                 |
| ------------------------- | ---------------------------------------------------- |
| ① 字节取反                | 对索引 `[1, 2, 3, 4, 99]` 的字节做 `255 - byte`      |
| ② Layer 字段重映射        | `name 2→1`、`features 1→2`、`keys 4→3`、`values 3→4` |
| ③ Feature 字段重映射      | `id 4→1`、`tags 3→2`、`type 2→3`、`geometry 1→4`     |
| ④ Value 字段重映射        | `double 3→2`、`float 2→3`（value 消息内字段号互换）  |
| ⑤ type 值重映射           | `1(LineString)→2`、`2(Polygon)→3`、`4(Point)→1`      |
| ⑥ geometry command 重映射 | `2(MoveTo)→1`、`3(LineTo)→2`、`7(ClosePath)` 不变    |

> 说明：②③④ 是 protobuf 字段编号（field number）的互换，⑤⑥ 是字段值（varint）的置换。这些变换都不改变字节长度，可以原地修改，无需重新分配缓冲区。

`download.js` 在下载时读取 `Pragma` 头，若为 `1` 则自动解密，落盘的即为**标准 MVT**，maplibre 可直接解析渲染。

### 4. 瓦片坐标与级别

- 坐标系：Web 墨卡托（EPSG:3857），XYZ 标准滑地图（Y 轴自上而下）。
- 级别：1 ~ 19（普通地图矢量瓦片）。
- 经纬度 → 瓦片坐标：

```js
function lngToX(lng, z) {
  return Math.floor(((lng + 180) / 360) * 2 ** z);
}
function latToY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z,
  );
}
```

---

## 三、脚本使用

### 1. 配置 `config.js`

```js
module.exports = {
  tk: "你的天地图密钥", // 必填
  point1: [116.2, 39.8], // 经纬度点1 [经度, 纬度]
  point2: [116.6, 40.1], // 经纬度点2，两点自动取包围盒
  minZoom: 1, // 起始级别
  maxZoom: 18, // 结束级别（最大 19）
  outputDir: "./dist", // 部署根目录（瓦片在 dist/tiles/ 下）
  concurrency: 8, // 并发数
  subdomains: ["tile0", "tile1", "tile2"], // 子域，不可用时自动回退
  // ... 其余保持默认即可
};
```

### 2. 下载瓦片（含解密）

```bash
node download.js
```

- 下载范围由 `point1`/`point2` 决定，级别由 `minZoom`/`maxZoom` 决定。
- 瓦片保存为 `dist/tiles/{z}/{x}/{y}.pbf`，**已是解密后的标准 MVT**。
- 自动生成 `dist/style.json`（合并天地图底图 + 注记样式，瓦片地址指向本地）。
- 支持断点续传（已下载的瓦片会跳过）。

### 3. 下载离线图标和字体（实现完全离线）

```bash
node download-static.js
```

- 下载 `sprite`（图标）到 `dist/sprite/`，下载 `glyphs`（字体）到 `dist/fonts/`。
- 把 `style.json` 里的 `sprite`/`glyphs` 改写为本地相对路径。
- 字体是 **`.pbf`（SDF 位图字形）**，不是 `.ttf`/`.otf`，这是 maplibre/mapbox 渲染文字的标准格式。

### 4. 本地渲染测试

```bash
python3 -m http.server 8080   # 在「项目根目录」启动（若 8080 被占用可换端口）
# 浏览器打开 http://localhost:8080/index.html
```

---

## 四、下载后如何还原使用

1. 瓦片已在 `download.js` 下载时自动解密，无需额外处理，`dist/tiles/{z}/{x}/{y}.pbf` 即为标准 MVT。
2. 用任意静态服务器托管「项目根目录」，`index.html` 通过相对路径加载 `dist/style.json` 渲染。
3. `index.html` 里已用 `transformRequest` 把相对路径统一转成绝对 URL（因 maplibre 在 Web Worker 中加载瓦片，无法解析相对路径），无需手动改端口。

### 前端项目集成（Vue CLI）

瓦片服务器地址**不写死在后端 `config.js`**，而是由前端环境变量注入：

- 后端 `config.js` 的 `style.tileBaseUrl` 留空 `''`，生成的 `style.json` 用纯相对路径（`tiles/{z}/{x}/{y}.pbf`、`sprite/png`、`fonts/{fontstack}/{range}.pbf`），不含主机名，产物可移植到任意服务器。
- 前端用 `VUE_APP_TILE_SERVER` 注入瓦片服务器地址，加载 `style.json` 后由 `transformRequest` 把相对路径拼成绝对 URL。

前端 `.env`（或 `.env.production`）：

```
VUE_APP_TILE_SERVER=http://183.56.226.80:30280/tiles/map/tiandi/vectors
```

地图初始化（leaflet + maplibre-gl-leaflet）：

```js
const TILE_SERVER = process.env.VUE_APP_TILE_SERVER;

const map = L.map("map", {
  minZoom: 1,
  maxZoom: 13, // 下载到 12 级，leaflet 侧需 +1
  maxBounds: [
    [85, -Infinity],
    [-85, Infinity],
  ],
  maxBoundsViscosity: 1,
}).setView([39.95, 116.4], 10);

L.maplibreGL({
  style: TILE_SERVER + "/style.json",
  transformRequest: (url) =>
    url.startsWith("http") ? { url } : { url: TILE_SERVER + "/" + url },
}).addTo(map);
```

注意：

- 瓦片服务器需开启 CORS（`Access-Control-Allow-Origin`），否则跨域 fetch 会被浏览器拦截。
- 前端若走 HTTPS 而瓦片服务器是 HTTP，会被浏览器当作混合内容拦截，需同源反代或给瓦片服务器上 HTTPS。

---

## 五、注意事项与已知问题

- **合规风险**：本项目逆向了天地图 `/vts` 端点的签名与加密逻辑，仅用于技术学习/内网研究。商用或公开分发前务必联系天地图官方确认使用授权。
- **算法可能变更**：`pk` 算法与加密方式随天地图前端更新可能变化，失效时需重新逆向。
- **端口冲突**：本机若 8080 被其它服务（如 nginx）占用，换一个空闲端口即可，因 `style.json` 与 `index.html` 均已改用相对路径，不依赖具体端口。
- **zoom 偏移**：`maplibre-gl-leaflet` 内部把 maplibre 的 zoom 设为 leaflet 的 `zoom - 1`，因此 leaflet 的 `maxZoom` 需比下载的最大级别多 1（下载到 18 就设 19，已在 `index.html` 处理）。
- **边界瓦片 404**：视图边缘超出下载范围的瓦片会 404，属正常，不影响下载范围内地图显示。
- **字体缺失**：`style.json` 中两个字体（`Open Sans Regular`、`WenQuanYi Micro Hei Mono Unicode MS Regular`）在天地图 CDN 上本身不存在，`download-static.js` 会自动跳过；在线渲染时同样 404，不影响主地图。

---

## 六、关于参考文章（参考.md）的不准确之处

- 端点域名：文章写 `t0.tianditu.gov.cn/vts`，实际是 `tile0.tianditu.gov.cn/vts`（`t0` 会 404）。
- 「pk 算法未公开」：不准确，算法就在官网前端 JS 里，可逆向还原。
- 「PBF 字节翻转 + Tag 重映射加密」：这部分基本属实，但加密不是单一「字节翻转」，而是字节取反 + 字段编号重映射 + type/command 重映射的复合变换。

## QA
