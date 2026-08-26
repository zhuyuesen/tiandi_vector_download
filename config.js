/**
 * 天地图普通地图矢量瓦片下载 - 配置文件
 *
 * 说明：天地图「普通地图」矢量瓦片主体走 /vts 端点，返回标准 MVT。
 * 请求需要携带 tk（开发者密钥）和动态签名 pk（由 x/y/z 计算得到，download.js 已实现）。
 */

module.exports = {
  // 天地图开发者密钥（tk）
  // 申请地址：https://console.tianditu.gov.cn/ （创建「浏览器端」应用）
  tk: '75f0434f240669f4a2df6359275146d2',

  // 下载范围：两个经纬度点，格式 [经度, 纬度]，顺序任意，会自动取包围盒
  point1: [-180, -90],
  point2: [180, 90],

  // 瓦片级别：起始 / 结束（天地图普通地图矢量瓦片支持 1 ~ 19）
  minZoom: 1,
  maxZoom: 9,

  // 部署根目录（相对当前目录或绝对路径），所有离线产物都放在这里：
  //   瓦片 tiles/、样式 style.json、图标 sprite/、字体 fonts/
  // 跨平台说明：脚本内部用 path.resolve/path.join 处理，已兼容 Windows/macOS/Linux。
  //   相对路径建议写 './dist'（正斜杠，跨平台安全）；
  //   绝对路径示例：macOS/Linux 用 '/data/tiles'，Windows 用 'D:/data/tiles' 或 'D:\\data\\tiles'
  outputDir: './dist',

  // 并发下载数
  concurrency: 8,

  // 子域轮询（tile0 ~ tile7 均可，建议保留多个；某子域不可用时 download.js 会自动回退）
  subdomains: ['tile0', 'tile1', 'tile2'],

  // 请求头（用于通过天地图的 CloudWAF，保持默认即可）
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Referer: 'https://map.tianditu.gov.cn/',
    Accept: '*/*',
  },

  // 是否在下载完成后生成 style.json（供 leaflet + @maplibre/maplibre-gl-leaflet 渲染）
  generateStyle: true,

  style: {
    // 部署根目录在静态服务器上对应的 URL 前缀（写入 style.json 的 tiles/sprite/glyphs）。
    // 这是 URL 路径，务必用正斜杠 '/'（与操作系统无关）；留空 '' 表示部署根即站点根目录。
    // 推荐留空 ''：生成的 style.json 用纯相对路径（tiles/...、sprite/...、fonts/...），
    // 不含主机名，产物可移植；瓦片服务器地址由前端通过环境变量注入（见 readme 第四节）。
    // 仅用 http-server 托管「项目根目录」做本地预览时，才需填 'dist'。
    tileBaseUrl: '',

    // 天地图矢量样式（底图 + 注记），会自动合并
    styleUrls: [
      'https://vector.tianditu.gov.cn/style/tdtStyle-vec-9.9.44-0.json',
      'https://vector.tianditu.gov.cn/style/tdtStyle-vec-9.9.44-1.json',
    ],

    // sprite 与 glyphs（字体/图标，默认使用官方 CDN；完全离线需自行下载并改为本地地址）
    sprite: 'https://vector.tianditu.gov.cn/static/sprite/png',
    glyphs: 'https://vector.tianditu.gov.cn/static/font/{fontstack}/{range}.pbf',

    // 离线 glyphs 字符范围（256 一组），null 表示用默认（基础拉丁 + 中文基本区）
    // 如需覆盖更多字符可自行指定，如 [[0, 255], [19968, 20223], ...]
    glyphRanges: null,
  },
};
