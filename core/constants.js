/**
 * Hằng số kỹ thuật Bilibili: bảng mã chất lượng (qn), codec hình/tiếng, header HTTP chuẩn.
 */

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BILIBILI_REFERER = 'https://www.bilibili.com/';
const BILIBILI_ORIGIN = 'https://www.bilibili.com';

const ALLOWED_COOKIE_DOMAINS = ['bilibili.com', 'bilivideo.com', 'b23.tv', 'hdslb.com'];

const BILIBILI_AUTH_COOKIE_KEYS = ['SESSDATA', 'DedeUserID', 'DedeUserID__ckMd5', 'bili_jct'];

// Bảng ánh xạ mã chất lượng (qn) thực tế của Bilibili API
const QUALITY_MAP = {
  127: { label: '8K UHD', shortLabel: '8K', order: 127, requiresVip: true, requiresLogin: true },
  126: { label: 'Dolby Vision', shortLabel: 'Dolby', order: 126, requiresVip: true, requiresLogin: true },
  125: { label: 'HDR TrueColor', shortLabel: 'HDR', order: 125, requiresVip: true, requiresLogin: true },
  120: { label: '4K UHD', shortLabel: '4K', order: 120, requiresVip: true, requiresLogin: true },
  116: { label: '1080P60 High FPS', shortLabel: '1080P60', order: 116, requiresVip: true, requiresLogin: true },
  112: { label: '1080P+ High Bitrate', shortLabel: '1080P+', order: 112, requiresVip: true, requiresLogin: true },
  100: { label: '2K QHD', shortLabel: '2K', order: 100, requiresVip: true, requiresLogin: true },
  80: { label: '1080P Full HD', shortLabel: '1080P', order: 80, requiresVip: false, requiresLogin: true },
  74: { label: '720P60 High FPS', shortLabel: '720P60', order: 74, requiresVip: false, requiresLogin: true },
  64: { label: '720P HD', shortLabel: '720P', order: 64, requiresVip: false, requiresLogin: false },
  32: { label: '480P SD', shortLabel: '480P', order: 32, requiresVip: false, requiresLogin: false },
  16: { label: '360P Fast', shortLabel: '360P', order: 16, requiresVip: false, requiresLogin: false },
  6: { label: '240P', shortLabel: '240P', order: 6, requiresVip: false, requiresLogin: false }
};

// Ánh xạ codecid trong dash.video[]
const VIDEO_CODEC_MAP = {
  7: { key: 'avc', name: 'H.264 (AVC)', compatNote: 'Tương thích tối đa mọi thiết bị & trình phát' },
  12: { key: 'hevc', name: 'H.265 (HEVC)', compatNote: 'Nhẹ hơn H.264, độ nét cao' },
  13: { key: 'av1', name: 'AV1', compatNote: 'Nén hiệu quả nhất, cần trình phát đời mới' }
};

// Ánh xạ ID luồng audio trong dash.audio[] / dolby / flac
const AUDIO_QUALITY_MAP = {
  30251: { label: 'Hi-Res Lossless (FLAC)', kbps: 1411, ext: 'flac' },
  30250: { label: 'Dolby Atmos', kbps: 640, ext: 'm4a' },
  30280: { label: '192 Kbps AAC (Cao)', kbps: 192, ext: 'm4a' },
  30232: { label: '132 Kbps AAC (Chuẩn)', kbps: 132, ext: 'm4a' },
  30216: { label: '64 Kbps AAC (Tiết kiệm)', kbps: 64, ext: 'm4a' }
};

// Cờ fnval=4048 bật đủ DASH (16) + HDR (64) + 4K (128) + Dolby Audio (256) + Dolby Vision (512) + 8K (1024) + AV1 (2048)
const DASH_FULL_FNVAL = 4048;

const OUTPUT_CONTAINERS = [
  { id: 'mp4', ext: 'mp4', label: 'MP4 (H.264 / Stream Copy gốc)', category: 'video' },
  { id: 'mkv', ext: 'mkv', label: 'MKV (Đa luồng không mất chất lượng)', category: 'video' },
  { id: 'mov', ext: 'mov', label: 'MOV (QuickTime / Dựng phim)', category: 'video' },
  { id: 'm4a', ext: 'm4a', label: 'M4A (Audio gốc giữ nguyên chất lượng)', category: 'audio' },
  { id: 'mp3', ext: 'mp3', label: 'MP3 (320 Kbps)', category: 'audio' }
];

module.exports = {
  DESKTOP_UA,
  BILIBILI_REFERER,
  BILIBILI_ORIGIN,
  ALLOWED_COOKIE_DOMAINS,
  BILIBILI_AUTH_COOKIE_KEYS,
  QUALITY_MAP,
  VIDEO_CODEC_MAP,
  AUDIO_QUALITY_MAP,
  DASH_FULL_FNVAL,
  OUTPUT_CONTAINERS
};
