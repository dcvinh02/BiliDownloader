// Giao diện BiliDownloader (Renderer)

const state = {
  appInfo: null,
  settings: null,
  cookieStatus: null,
  analysis: null,
  selectedPartNum: 1,
  selectedMode: 'video_audio', // 'video_audio' | 'video_only' | 'audio_only'
  selectedStreamKey: null,
  selectedAudioId: null,
  customSaveDir: null,
  jobs: [],
  history: [],
  spaceState: { input: '', page: 1, data: null, selectedSet: new Set() }
};

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '—';
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function fmtNum(val) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return null;
  const n = Number(val);
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} ức`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} vạn`;
  return n.toLocaleString('vi-VN');
}

function proxyMediaUrl(rawUrl) {
  if (!rawUrl) return '';
  if (!state.appInfo?.mediaProxyBase) return rawUrl;
  return `${state.appInfo.mediaProxyBase}?url=${encodeURIComponent(rawUrl)}&referer=${encodeURIComponent('https://www.bilibili.com/')}`;
}

function toast(msg, type = 'info') {
  const box = $('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3800);
}

function switchView(viewId) {
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === viewId);
  });
  document.querySelectorAll('.view-pane').forEach((p) => {
    p.classList.toggle('active', p.id === `view-${viewId}`);
  });
  if (viewId === 'queue') renderQueue();
  if (viewId === 'history') loadHistory();
  if (viewId === 'settings') refreshSettingsView();
}

function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  $('themeToggleLabel').textContent = t === 'light' ? '☀ Giao diện Sáng' : '🌙 Giao diện Tối';
  if ($('setTheme')) $('setTheme').value = t;
}

function updateCookieIndicator() {
  const st = state.cookieStatus;
  const dot = $('cookieStatusDot');
  const lbl = $('sidebarCookieLabel');
  if (!st || !st.valid) {
    dot.className = 'status-dot';
    lbl.textContent = 'Khách (Chưa Cookie)';
  } else if (st.hasSessData) {
    dot.className = 'status-dot ok';
    lbl.textContent = st.dedeUserId ? `Đã đăng nhập (UID ${st.dedeUserId})` : 'Đã nạp Cookie (SESSDATA)';
  } else {
    dot.className = 'status-dot warn';
    lbl.textContent = 'Cookie thiếu SESSDATA';
  }
  if ($('settingsCookieBanner')) {
    $('settingsCookieBanner').textContent = st?.message || 'Chưa cấu hình Cookie.';
  }
}

// ==================== PHÂN TÍCH URL & HIỂN THỊ THÔNG TIN ====================

async function handleAnalyze(overrideUrl = null) {
  const raw = overrideUrl !== null ? overrideUrl : $('urlInput').value.trim();
  if (!raw) {
    toast('Vui lòng nhập URL Bilibili hoặc mã BV/AV.', 'warn');
    return;
  }
  if (overrideUrl !== null) $('urlInput').value = overrideUrl;

  $('analyzeErrorBox').classList.add('hidden');
  $('analyzeBtn').disabled = true;
  $('analyzeSpinner').classList.remove('hidden');
  $('analyzeBtnText').textContent = 'Đang phân tích...';

  try {
    const res = await window.biliApi.analyzeUrl(raw);
    if (res.contentType === 'space' && res.spaceData) {
      // Nếu người dùng dán link space.bilibili.com vào ô chính -> tự chuyển sang tab Quét kênh UP
      state.spaceState = {
        input: res.spaceData.profile.mid,
        page: 1,
        data: res.spaceData,
        selectedSet: new Set()
      };
      $('spaceInput').value = res.parsed.cleanUrl;
      renderSpaceResult();
      switchView('space');
      toast(`Đã nhận diện kênh UP: ${res.spaceData.profile.name}`, 'success');
      return;
    }

    state.analysis = res;
    state.selectedPartNum = res.data.selectedPageNum || 1;
    state.customSaveDir = state.settings.downloadDir;
    renderAnalysisResult();
    toast('Phân tích thông tin video thành công!', 'success');
  } catch (err) {
    $('videoResultContainer').classList.add('hidden');
    $('analyzeErrorBox').textContent = err.message || 'Phân tích URL thất bại.';
    $('analyzeErrorBox').classList.remove('hidden');
  } finally {
    $('analyzeBtn').disabled = false;
    $('analyzeSpinner').classList.add('hidden');
    $('analyzeBtnText').textContent = 'Phân tích';
  }
}

function renderPreviewBox(showEmbed = false) {
  const info = state.analysis?.data;
  if (!info) return;
  const box = $('previewBox');
  const coverSrc = proxyMediaUrl(info.cover);

  if (showEmbed && info.embedUrl) {
    box.innerHTML = `<iframe src="${escapeHtml(info.embedUrl)}" allowfullscreen allow="autoplay; encrypted-media"></iframe>`;
    $('previewActionsBar').innerHTML = `<button class="btn btn-sm btn-secondary" id="backCoverBtn">Quay lại Thumbnail</button>`;
    $('backCoverBtn').onclick = () => renderPreviewBox(false);
  } else {
    box.innerHTML = `
      <img src="${escapeHtml(coverSrc)}" alt="Thumbnail" class="cover-img" onerror="this.style.opacity='0.2'">
      <span class="duration-pill">${fmtDuration(info.duration)}</span>
    `;
    $('previewActionsBar').innerHTML = info.embedUrl
      ? `<button class="btn btn-sm btn-secondary" id="openEmbedBtn">▶ Xem trước bằng Bilibili Player</button>`
      : '';
    if ($('openEmbedBtn')) {
      $('openEmbedBtn').onclick = () => renderPreviewBox(true);
    }
  }
}

function renderAnalysisResult() {
  const info = state.analysis?.data;
  if (!info) return;
  $('videoResultContainer').classList.remove('hidden');

  renderPreviewBox(false);

  // Tác giả
  $('resAuthorName').textContent = info.author || 'Không rõ tác giả';
  $('resAuthorUid').textContent = info.authorMid ? `UID: ${info.authorMid}` : '';
  if (info.authorAvatar) {
    $('resAuthorAvatar').src = proxyMediaUrl(info.authorAvatar);
    $('resAuthorAvatar').classList.remove('hidden');
  } else {
    $('resAuthorAvatar').classList.add('hidden');
  }
  if (info.authorMid) {
    $('scanAuthorBtn').classList.remove('hidden');
    $('scanAuthorBtn').onclick = () => {
      $('spaceInput').value = `https://space.bilibili.com/${info.authorMid}`;
      switchView('space');
      handleScanSpace(1);
    };
  } else {
    $('scanAuthorBtn').classList.add('hidden');
  }

  $('resCleanUrl').value = info.cleanUrl || '';

  // Badges: BV / AV / CID / Category
  const badges = [];
  if (info.bvid) badges.push(`<span class="badge badge-accent">${escapeHtml(info.bvid)}</span>`);
  if (info.aid) badges.push(`<span class="badge">av${escapeHtml(info.aid)}</span>`);
  if (info.cid) badges.push(`<span class="badge">CID: ${escapeHtml(info.cid)}</span>`);
  if (info.tname) badges.push(`<span class="badge">${escapeHtml(info.tname)}</span>`);
  if (info.pages?.length > 1) badges.push(`<span class="badge badge-accent">${info.pages.length} phần</span>`);
  if (info.playlist) badges.push(`<span class="badge badge-accent">Playlist: ${info.playlist.totalEpisodes} tập</span>`);
  $('resBadgesRow').innerHTML = badges.join('');

  $('resTitle').textContent = info.title || 'Không có tiêu đề';

  // Chỉ hiển thị các thống kê THỰC SỰ có dữ liệu từ Bilibili
  const statsItems = [
    { label: 'Thời lượng', val: info.duration ? fmtDuration(info.duration) : null },
    { label: 'Ngày đăng', val: info.pubdateText || null },
    { label: 'Lượt xem', val: fmtNum(info.stats?.views) },
    { label: 'Lượt thích', val: fmtNum(info.stats?.likes) },
    { label: 'Xu (Coin)', val: fmtNum(info.stats?.coins) },
    { label: 'Yêu thích', val: fmtNum(info.stats?.favorites) },
    { label: 'Chia sẻ', val: fmtNum(info.stats?.shares) },
    { label: 'Bình luận', val: fmtNum(info.stats?.comments) },
    { label: 'Danmaku', val: fmtNum(info.stats?.danmaku) }
  ].filter((x) => x.val !== null);

  $('resStatsGrid').innerHTML = statsItems
    .map(
      (s) => `
      <div class="stat-cell">
        <div class="stat-k">${escapeHtml(s.label)}</div>
        <div class="stat-v">${escapeHtml(s.val)}</div>
      </div>`
    )
    .join('');

  // Mô tả video
  if (info.description && info.description.trim()) {
    $('resDescBox').classList.remove('hidden');
    $('resDescText').textContent = info.description.trim();
    $('resDescText').classList.remove('expanded');
    const isLong = info.description.length > 180;
    $('toggleDescBtn').classList.toggle('hidden', !isLong);
    $('toggleDescBtn').textContent = 'Xem thêm';
  } else {
    $('resDescBox').classList.add('hidden');
  }

  // Các phần (Pages) hoặc Playlist
  renderPartsAndPlaylist();

  // Danh sách chất lượng & Tùy chọn tải
  selectDefaultStreams();
  renderQualityOptions();
  updateOutputOptionsUI();
}

function renderPartsAndPlaylist() {
  const info = state.analysis?.data;
  const card = $('partsOrPlaylistCard');
  const listEl = $('partsList');

  const hasMultiPages = Array.isArray(info.pages) && info.pages.length > 1;
  const hasPlaylist = Boolean(info.playlist && info.playlist.episodes?.length > 0);

  if (!hasMultiPages && !hasPlaylist) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  if (hasMultiPages) {
    $('partsSectionTitle').textContent = `Video gồm ${info.pages.length} phần (Pages)`;
    $('partsSectionSub').textContent = 'Nhấn vào từng phần để xem chất lượng riêng, hoặc tick chọn để thêm hàng loạt vào hàng đợi.';
    listEl.innerHTML = info.pages
      .map(
        (p) => `
        <div class="part-item ${p.page === state.selectedPartNum ? 'active' : ''}" data-part-num="${p.page}">
          <input type="checkbox" class="part-chk" data-url="${escapeHtml(p.url)}" data-title="${escapeHtml(`${info.title} - P${p.page} ${p.title}`)}" onclick="event.stopPropagation()">
          <span class="part-title">P${p.page}: ${escapeHtml(p.title)}</span>
          <span class="part-dur">${fmtDuration(p.duration)}</span>
        </div>`
      )
      .join('');
    listEl.querySelectorAll('.part-item').forEach((el) => {
      el.onclick = () => switchVideoPart(Number(el.dataset.partNum));
    });
  } else if (hasPlaylist) {
    $('partsSectionTitle').textContent = `${info.playlist.title} (${info.playlist.totalEpisodes} tập)`;
    $('partsSectionSub').textContent = 'Nhấn vào tập bất kỳ để phân tích chi tiết, hoặc tick chọn nhiều tập để tải hàng loạt.';
    listEl.innerHTML = info.playlist.episodes
      .map(
        (ep, idx) => `
        <div class="part-item ${ep.bvid === info.bvid || ep.epId === info.epId ? 'active' : ''}" data-ep-url="${escapeHtml(ep.url)}">
          <input type="checkbox" class="part-chk" data-url="${escapeHtml(ep.url)}" data-title="${escapeHtml(ep.title)}" onclick="event.stopPropagation()">
          <span class="part-title">${idx + 1}. ${escapeHtml(ep.title)}</span>
          <span class="part-dur">${fmtDuration(ep.duration)}</span>
        </div>`
      )
      .join('');
    listEl.querySelectorAll('.part-item').forEach((el) => {
      el.onclick = () => handleAnalyze(el.dataset.epUrl);
    });
  }
}

async function switchVideoPart(pageNum) {
  const info = state.analysis?.data;
  const part = info?.pages?.find((p) => p.page === pageNum);
  if (!part) return;
  try {
    toast(`Đang lấy luồng chất lượng của P${part.page}...`);
    const streams = await window.biliApi.fetchPartQualities({
      bvid: info.bvid,
      aid: info.aid,
      cid: String(part.cid),
      durationSec: part.duration
    });
    info.cid = String(part.cid);
    info.duration = part.duration;
    info.selectedPageNum = part.page;
    info.cleanUrl = part.url;
    info.streams = streams;
    state.selectedPartNum = part.page;
    renderAnalysisResult();
  } catch (err) {
    toast(`Không lấy được phần P${pageNum}: ${err.message}`, 'error');
  }
}

function getCombinedVideoOptions() {
  const streams = state.analysis?.data?.streams;
  if (!streams) return [];
  const merged = [...(streams.videoStreams || []), ...(streams.progressiveStreams || [])];
  merged.sort((a, b) => {
    if ((b.qn || 0) !== (a.qn || 0)) return (b.qn || 0) - (a.qn || 0);
    // Nếu cùng mức qn: ưu tiên DASH H.264/HEVC hoặc Progressive MP4
    const aDash = a.streamKind === 'dash_video' ? 1 : 0;
    const bDash = b.streamKind === 'dash_video' ? 1 : 0;
    return bDash - aDash;
  });
  return merged;
}

function selectDefaultStreams() {
  const streams = state.analysis?.data?.streams;
  const videos = getCombinedVideoOptions();
  state.selectedStreamKey = videos[0]?.streamKey || null;
  state.selectedAudioId = streams?.audioStreams?.[0]?.audioId || null;
}

function renderQualityOptions() {
  const streams = state.analysis?.data?.streams;
  if (!streams) return;
  $('streamEngineLabel').textContent = `Nguồn trích xuất: ${streams.engine || 'Bilibili API'}`;

  const qListEl = $('videoQualityList');
  const audioRow = $('audioTrackRow');
  const audioSel = $('audioTrackSelect');
  const lockedBox = $('lockedQualitiesBox');

  if (state.selectedMode === 'audio_only') {
    qListEl.innerHTML = '';
    if (!streams.audioStreams?.length) {
      qListEl.innerHTML = `<div class="empty-state">Video này không có luồng Audio tách riêng (hãy chọn định dạng MP3 trong chế độ Video + Âm thanh).</div>`;
    } else {
      qListEl.innerHTML = streams.audioStreams
        .map(
          (a) => `
          <label class="quality-row ${String(state.selectedAudioId) === String(a.audioId) ? 'selected' : ''}">
            <input type="radio" name="audChoice" value="${escapeHtml(a.audioId)}" ${String(state.selectedAudioId) === String(a.audioId) ? 'checked' : ''}>
            <span class="q-label">${escapeHtml(a.label)}</span>
            <span class="q-meta">${escapeHtml(a.codecsRaw || 'AAC')}</span>
            <span class="q-muted">${a.bitrateKbps ? `${a.bitrateKbps} kbps` : ''}</span>
            <span class="q-muted">Audio Only</span>
            <span class="q-muted">${a.estimatedBytes ? `~${fmtBytes(a.estimatedBytes)}` : '—'}</span>
          </label>`
        )
        .join('');
      qListEl.querySelectorAll('input[name="audChoice"]').forEach((r) => {
        r.onchange = () => {
          state.selectedAudioId = r.value;
          renderQualityOptions();
        };
      });
    }
    audioRow.classList.add('hidden');
    lockedBox.classList.add('hidden');
    return;
  }

  const options = getCombinedVideoOptions();
  if (options.length === 0) {
    qListEl.innerHTML = `<div class="empty-state">Không tìm thấy luồng video khả dụng cho nội dung này.</div>`;
  } else {
    qListEl.innerHTML = options
      .map((v) => {
        const isSel = v.streamKey === state.selectedStreamKey;
        const resText = v.width && v.height ? `${v.width}×${v.height}` : 'Tự động';
        const fpsText = v.fps ? `${v.fps} fps` : '';
        const brText = v.bitrateKbps ? `${v.bitrateKbps} kbps` : '';
        const kindText = v.requiresMerge ? 'DASH (Ghép FFmpeg)' : 'MP4 Gộp sẵn';
        const sizeText = v.exactBytes ? fmtBytes(v.exactBytes) : v.estimatedBytes ? `~${fmtBytes(v.estimatedBytes)}` : '—';
        return `
        <label class="quality-row ${isSel ? 'selected' : ''}">
          <input type="radio" name="vidChoice" value="${escapeHtml(v.streamKey)}" ${isSel ? 'checked' : ''}>
          <span class="q-label">${escapeHtml(v.qualityLabel)}</span>
          <span class="q-meta">${escapeHtml(v.codecName || 'MP4')} • ${escapeHtml(resText)} ${escapeHtml(fpsText)}</span>
          <span class="q-muted">${escapeHtml(brText)}</span>
          <span class="q-muted">${escapeHtml(kindText)}</span>
          <span class="q-muted">${escapeHtml(sizeText)}</span>
        </label>`;
      })
      .join('');
    qListEl.querySelectorAll('input[name="vidChoice"]').forEach((r) => {
      r.onchange = () => {
        state.selectedStreamKey = r.value;
        renderQualityOptions();
      };
    });
  }

  // Luồng Audio đi kèm (khi Video+Audio dùng DASH)
  const chosenVideo = options.find((v) => v.streamKey === state.selectedStreamKey);
  if (state.selectedMode === 'video_audio' && chosenVideo?.requiresMerge && streams.audioStreams?.length > 0) {
    audioRow.classList.remove('hidden');
    audioSel.innerHTML = streams.audioStreams
      .map(
        (a) =>
          `<option value="${escapeHtml(a.audioId)}" ${String(state.selectedAudioId) === String(a.audioId) ? 'selected' : ''}>${escapeHtml(
            a.label
          )} (${escapeHtml(a.codecsRaw)}) ${a.estimatedBytes ? `• ~${fmtBytes(a.estimatedBytes)}` : ''}</option>`
      )
      .join('');
    audioSel.onchange = () => {
      state.selectedAudioId = audioSel.value;
    };
  } else {
    audioRow.classList.add('hidden');
  }

  // Các chất lượng bị khóa (VIP/Login) — hiển thị minh bạch nhưng không cho chọn
  if (streams.lockedQualities?.length > 0) {
    lockedBox.classList.remove('hidden');
    const names = streams.lockedQualities.map((q) => q.qualityLabel).join(', ');
    lockedBox.textContent = `Chất lượng yêu cầu tài khoản đăng nhập / VIP (chưa mở khóa với Cookie hiện tại): ${names}`;
  } else {
    lockedBox.classList.add('hidden');
  }
}

function updateOutputOptionsUI() {
  const info = state.analysis?.data;
  if (!info) return;

  const partTag = info.pages?.length > 1 ? ` P${info.selectedPageNum}` : '';
  const idTag = info.bvid ? ` [${info.bvid}]` : '';
  $('customFilenameInput').value = `${info.title || 'Bilibili'}${partTag}${idTag}`;
  $('taskSaveDirInput').value = state.customSaveDir || state.settings?.downloadDir || '';

  const sel = $('outputFormatSelect');
  if (state.selectedMode === 'audio_only') {
    sel.innerHTML = `
      <option value="m4a">M4A (Âm thanh gốc giữ nguyên chất lượng)</option>
      <option value="mp3">MP3 (Chuyển đổi 320 Kbps tương thích mọi máy)</option>
    `;
  } else {
    sel.innerHTML = `
      <option value="mp4">MP4 (Stream Copy giữ nguyên chất lượng)</option>
      <option value="mkv">MKV (Matroska giữ nguyên codec gốc)</option>
      <option value="mov">MOV (QuickTime)</option>
    `;
  }
}

async function handleStartDownload() {
  const info = state.analysis?.data;
  if (!info) return;

  const streams = info.streams || {};
  const videoStream = getCombinedVideoOptions().find((v) => v.streamKey === state.selectedStreamKey) || null;
  const audioStream =
    streams.audioStreams?.find((a) => String(a.audioId) === String(state.selectedAudioId)) ||
    streams.audioStreams?.[0] ||
    null;

  if (state.selectedMode !== 'audio_only' && !videoStream) {
    toast('Vui lòng chọn một luồng video khả dụng.', 'warn');
    return;
  }
  if (state.selectedMode === 'audio_only' && !audioStream && !videoStream) {
    toast('Không có luồng âm thanh khả dụng.', 'warn');
    return;
  }

  const task = {
    bvid: info.bvid,
    aid: info.aid,
    cid: info.cid,
    epId: info.epId || null,
    title: info.title,
    author: info.author,
    duration: info.duration,
    thumbnail: info.cover,
    sourceUrl: info.cleanUrl,
    customFileName: $('customFilenameInput').value.trim(),
    saveDir: $('taskSaveDirInput').value.trim(),
    mode: state.selectedMode,
    outputFormat: $('outputFormatSelect').value,
    videoStream,
    audioStream,
    metadataSnapshot: {
      bvid: info.bvid,
      aid: info.aid,
      cid: info.cid,
      title: info.title,
      author: info.author,
      authorMid: info.authorMid,
      duration: info.duration,
      pubdate: info.pubdate,
      stats: info.stats,
      cleanUrl: info.cleanUrl,
      downloadedQuality: videoStream?.qualityLabel || audioStream?.label || ''
    }
  };

  await window.biliApi.enqueueDownload(task);
  await refreshQueueFromMain();
  toast('Đã thêm video vào hàng đợi tải!', 'success');
  switchView('queue');
}

async function handleEnqueueSelectedParts() {
  const checked = Array.from(document.querySelectorAll('#partsList .part-chk:checked'));
  if (checked.length === 0) {
    toast('Hãy tick chọn ít nhất 1 phần hoặc tập cần tải.', 'warn');
    return;
  }

  $('enqueueSelectedPartsBtn').disabled = true;
  let added = 0;
  for (const chk of checked) {
    try {
      const res = await window.biliApi.analyzeUrl(chk.dataset.url);
      const d = res.data;
      const allVids = [...(d.streams?.videoStreams || []), ...(d.streams?.progressiveStreams || [])].sort(
        (a, b) => (b.qn || 0) - (a.qn || 0)
      );
      const vid = allVids[0] || null;
      const aud = d.streams?.audioStreams?.[0] || null;
      if (!vid) continue;
      await window.biliApi.enqueueDownload({
        bvid: d.bvid,
        aid: d.aid,
        cid: d.cid,
        epId: d.epId || null,
        title: chk.dataset.title || d.title,
        author: d.author,
        duration: d.duration,
        thumbnail: d.cover,
        sourceUrl: d.cleanUrl,
        mode: 'video_audio',
        outputFormat: 'mp4',
        videoStream: vid,
        audioStream: aud
      });
      added++;
    } catch (err) {
      toast(`Lỗi thêm mục "${chk.dataset.title}": ${err.message}`, 'error');
    }
  }
  $('enqueueSelectedPartsBtn').disabled = false;
  await refreshQueueFromMain();
  toast(`Đã thêm ${added}/${checked.length} mục vào hàng đợi!`, 'success');
  if (added > 0) switchView('queue');
}

// ==================== HÀNG ĐỢI TẢI XUỐNG ====================

async function refreshQueueFromMain() {
  state.jobs = await window.biliApi.listDownloads();
  updateQueueBadge();
  renderQueue();
}

function updateQueueBadge() {
  const activeCount = state.jobs.filter((j) => ['queued', 'downloading', 'merging'].includes(j.status)).length;
  const badge = $('queueCountBadge');
  badge.textContent = String(activeCount);
  badge.classList.toggle('hidden', activeCount === 0);
}

function renderQueue() {
  const running = state.jobs.filter((j) => j.status === 'downloading' || j.status === 'merging').length;
  const queued = state.jobs.filter((j) => j.status === 'queued').length;
  $('queueSummaryLabel').textContent = `Đang chạy: ${running} / tối đa ${state.settings?.maxConcurrent || 2} • Đang chờ: ${queued} • Tổng: ${state.jobs.length}`;

  const el = $('queueList');
  if (state.jobs.length === 0) {
    el.innerHTML = `<div class="empty-state">Chưa có tác vụ tải nào trong hàng đợi.</div>`;
    return;
  }

  el.innerHTML = state.jobs
    .map((j) => {
      const fillCls =
        j.status === 'completed'
          ? 'done'
          : j.status === 'failed'
          ? 'err'
          : j.status === 'paused'
          ? 'paused'
          : '';
      const thumb = j.thumbnail ? proxyMediaUrl(j.thumbnail) : '../assets/icon.png';
      return `
      <div class="task-card">
        <img class="task-thumb" src="${escapeHtml(thumb)}" alt="" onerror="this.src='../assets/icon.png'">
        <div class="task-body">
          <div class="task-title" title="${escapeHtml(j.title)}">${escapeHtml(j.title)}</div>
          <div class="task-sub">
            <strong>${escapeHtml(j.qualityLabel)}</strong> • ${escapeHtml(j.codecName || '')} • .${escapeHtml(
        (j.outputFormat || 'mp4').toUpperCase()
      )} • ${escapeHtml(j.statusText || j.status)}
          </div>
          <div class="progress-track">
            <div class="progress-fill ${fillCls}" style="width:${j.progress || 0}%"></div>
          </div>
          <div class="task-metrics">
            <span>${j.progress || 0}%</span>
            <span>${fmtBytes(j.downloadedBytes)} / ${j.totalBytes ? fmtBytes(j.totalBytes) : '—'}</span>
            <span>Tốc độ: ${escapeHtml(j.speedText || '0 KB/s')}</span>
            <span>Còn lại: ${escapeHtml(j.etaText || '--:--')}</span>
          </div>
          ${j.error ? `<div class="task-error">Lỗi: ${escapeHtml(j.error)}</div>` : ''}
        </div>
        <div class="task-actions">
          ${
            j.status === 'downloading' || j.status === 'queued'
              ? `<button class="btn btn-sm btn-secondary" onclick="jobAction('pause','${escapeHtml(j.jobId)}')">Tạm dừng</button>`
              : ''
          }
          ${
            j.status === 'paused'
              ? `<button class="btn btn-sm btn-primary" onclick="jobAction('resume','${escapeHtml(j.jobId)}')">Tiếp tục</button>`
              : ''
          }
          ${
            j.status === 'failed' || j.status === 'cancelled'
              ? `<button class="btn btn-sm btn-primary" onclick="jobAction('retry','${escapeHtml(j.jobId)}')">Thử lại</button>`
              : ''
          }
          ${
            ['queued', 'downloading', 'merging', 'paused'].includes(j.status)
              ? `<button class="btn btn-sm btn-danger-outline" onclick="jobAction('cancel','${escapeHtml(j.jobId)}')">Hủy</button>`
              : ''
          }
          ${
            j.status === 'completed'
              ? `<button class="btn btn-sm btn-primary" onclick="openFilePath('${escapeHtml(j.outputPath)}')">▶ Mở video</button>
                 <button class="btn btn-sm btn-secondary" onclick="openFolderPath('${escapeHtml(j.outputPath)}')">📁 Thư mục</button>`
              : ''
          }
          ${
            ['completed', 'failed', 'cancelled'].includes(j.status)
              ? `<button class="btn btn-sm btn-secondary" onclick="jobAction('remove','${escapeHtml(j.jobId)}')">✕</button>`
              : ''
          }
        </div>
      </div>`;
    })
    .join('');
}

window.jobAction = async (action, jobId) => {
  if (action === 'pause') await window.biliApi.pauseDownload(jobId);
  if (action === 'resume') await window.biliApi.resumeDownload(jobId);
  if (action === 'retry') await window.biliApi.retryDownload(jobId);
  if (action === 'cancel') await window.biliApi.cancelDownload(jobId);
  if (action === 'remove') await window.biliApi.removeDownload(jobId);
  await refreshQueueFromMain();
};

window.openFilePath = (p) => window.biliApi.openPath(p);
window.openFolderPath = (p) => window.biliApi.showInFolder(p);

// ==================== QUÉT KÊNH UP (SPACE) ====================

async function handleScanSpace(page = 1) {
  const inp = $('spaceInput').value.trim();
  if (!inp) {
    toast('Vui lòng nhập link Space, UID hoặc tên kênh Bilibili.', 'warn');
    return;
  }
  $('spaceErrorBox').classList.add('hidden');
  $('scanSpaceBtn').disabled = true;
  $('spaceSpinner').classList.remove('hidden');

  try {
    const res = await window.biliApi.scanSpace({ input: inp, page, pageSize: 20 });
    state.spaceState = { input: inp, page, data: res, selectedSet: new Set() };
    renderSpaceResult();
  } catch (err) {
    $('spaceErrorBox').textContent = err.message || 'Không quét được kênh Space Bilibili.';
    $('spaceErrorBox').classList.remove('hidden');
  } finally {
    $('scanSpaceBtn').disabled = false;
    $('spaceSpinner').classList.add('hidden');
  }
}

function renderSpaceResult() {
  const data = state.spaceState.data;
  if (!data) return;
  $('spaceResultContainer').classList.remove('hidden');

  const p = data.profile;
  $('spaceName').textContent = p.name || `UID ${p.mid}`;
  $('spaceMeta').textContent = `UID: ${p.mid} • ${p.followers !== null ? `${fmtNum(p.followers)} theo dõi` : ''} • ${
    data.totalCount ?? p.archiveCount ?? data.items.length
  } video • Nguồn: ${data.usedMethod}`;
  $('spaceSign').textContent = p.sign || '';
  if (p.avatar) {
    $('spaceAvatar').src = proxyMediaUrl(p.avatar);
    $('spaceAvatar').classList.remove('hidden');
  }

  $('spacePageLabel').textContent = `Trang ${data.page}`;
  $('spacePrevBtn').disabled = data.page <= 1;
  $('spaceNextBtn').disabled = !data.hasMore;

  const grid = $('spaceVideosGrid');
  grid.innerHTML = data.items
    .map(
      (it) => `
      <div class="space-item">
        <div class="space-thumb-wrap">
          <img src="${escapeHtml(proxyMediaUrl(it.cover))}" alt="" onerror="this.style.opacity='0.2'">
          <input type="checkbox" class="space-check" data-url="${escapeHtml(it.url)}" data-title="${escapeHtml(it.title)}">
          <span class="duration-pill">${fmtDuration(it.duration)}</span>
        </div>
        <div class="space-item-body">
          <div class="space-item-title" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</div>
          <div class="space-item-foot">
            <span>${it.pubdateText || it.bvid}</span>
            <button class="btn btn-sm btn-secondary space-open-btn" data-url="${escapeHtml(it.url)}">Phân tích</button>
          </div>
        </div>
      </div>`
    )
    .join('');

  grid.querySelectorAll('.space-open-btn').forEach((btn) => {
    btn.onclick = () => {
      switchView('download');
      handleAnalyze(btn.dataset.url);
    };
  });
}

async function handleEnqueueSpaceSelected() {
  const checks = Array.from(document.querySelectorAll('#spaceVideosGrid .space-check:checked'));
  if (checks.length === 0) {
    toast('Hãy chọn ít nhất 1 video từ danh sách kênh.', 'warn');
    return;
  }
  $('spaceEnqueueBtn').disabled = true;
  let added = 0;
  for (const c of checks) {
    try {
      const res = await window.biliApi.analyzeUrl(c.dataset.url);
      const d = res.data;
      const allVids = [...(d.streams?.videoStreams || []), ...(d.streams?.progressiveStreams || [])].sort(
        (a, b) => (b.qn || 0) - (a.qn || 0)
      );
      const vid = allVids[0] || null;
      const aud = d.streams?.audioStreams?.[0] || null;
      if (!vid) continue;
      await window.biliApi.enqueueDownload({
        bvid: d.bvid,
        aid: d.aid,
        cid: d.cid,
        title: d.title,
        author: d.author,
        duration: d.duration,
        thumbnail: d.cover,
        sourceUrl: d.cleanUrl,
        mode: 'video_audio',
        outputFormat: 'mp4',
        videoStream: vid,
        audioStream: aud
      });
      added++;
    } catch {}
  }
  $('spaceEnqueueBtn').disabled = false;
  await refreshQueueFromMain();
  toast(`Đã đưa ${added}/${checks.length} video vào hàng đợi!`, 'success');
  if (added > 0) switchView('queue');
}

// ==================== LỊCH SỬ TẢI XUỐNG ====================

async function loadHistory() {
  state.history = await window.biliApi.listHistory();
  renderHistory();
}

function renderHistory() {
  const q = ($('historySearchInput')?.value || '').trim().toLowerCase();
  const list = state.history.filter(
    (h) => !q || (h.title || '').toLowerCase().includes(q) || (h.bvid || '').toLowerCase().includes(q)
  );
  const el = $('historyList');
  if (list.length === 0) {
    el.innerHTML = `<div class="empty-state">Không có mục lịch sử nào.</div>`;
    return;
  }

  el.innerHTML = list
    .map((h) => {
      const thumb = h.thumbnail ? proxyMediaUrl(h.thumbnail) : '../assets/icon.png';
      const dateStr = h.downloadedAt ? new Date(h.downloadedAt).toLocaleString('vi-VN') : '';
      return `
      <div class="task-card">
        <img class="task-thumb" src="${escapeHtml(thumb)}" alt="" onerror="this.src='../assets/icon.png'">
        <div class="task-body">
          <div class="task-title">${escapeHtml(h.title)}</div>
          <div class="task-sub">
            ${h.bvid ? `<code>${escapeHtml(h.bvid)}</code> • ` : ''}
            <strong>${escapeHtml(h.qualityLabel)}</strong> • ${escapeHtml(h.codecName || '')} • ${fmtBytes(h.fileSize)} • ${escapeHtml(dateStr)}
          </div>
          <div class="task-sub">${escapeHtml(h.outputPath || '')}</div>
        </div>
        <div class="task-actions">
          ${h.outputPath ? `<button class="btn btn-sm btn-primary" onclick="openFilePath('${escapeHtml(h.outputPath)}')">▶ Mở</button>` : ''}
          ${h.outputPath ? `<button class="btn btn-sm btn-secondary" onclick="openFolderPath('${escapeHtml(h.outputPath)}')">📁 Thư mục</button>` : ''}
          ${h.sourceUrl ? `<button class="btn btn-sm btn-secondary" onclick="redownloadHistory('${escapeHtml(h.sourceUrl)}')">↻ Tải lại</button>` : ''}
          <button class="btn btn-sm btn-danger-outline" onclick="deleteHistoryItem('${escapeHtml(h.id)}')">Xóa</button>
        </div>
      </div>`;
    })
    .join('');
}

window.redownloadHistory = (url) => {
  switchView('download');
  handleAnalyze(url);
};

window.deleteHistoryItem = async (id) => {
  await window.biliApi.removeHistory(id, false);
  await loadHistory();
};

// ==================== CÀI ĐẶT & COOKIE ====================

async function refreshSettingsView() {
  state.settings = await window.biliApi.getSettings();
  state.cookieStatus = await window.biliApi.getCookieStatus();
  $('setDownloadDir').value = state.settings.downloadDir || '';
  $('setMaxConcurrent').value = String(state.settings.maxConcurrent || 2);
  $('setTheme').value = state.settings.theme || 'dark';
  $('setSaveMetadata').checked = Boolean(state.settings.saveMetadataJson);
  updateCookieIndicator();

  const logs = await window.biliApi.getRecentLogs();
  $('logsBox').textContent = logs.join('\n') || '(Chưa có log)';

  if (state.appInfo) {
    $('sysDiagLabel').textContent = `Phiên bản ${state.appInfo.version} (${state.appInfo.platform}/${state.appInfo.arch}) • FFmpeg: ${
      state.appInfo.ffmpegExists ? 'Sẵn sàng' : 'Thiếu'
    } (${state.appInfo.ffmpegPath})`;
  }
}

// ==================== KHỞI TẠO SỰ KIỆN ====================

async function bootstrap() {
  state.appInfo = await window.biliApi.getAppInfo();
  state.settings = await window.biliApi.getSettings();
  state.cookieStatus = await window.biliApi.getCookieStatus();

  $('appVersionBadge').textContent = `v${state.appInfo.version} • Chỉ Bilibili`;
  applyTheme(state.settings.theme);
  updateCookieIndicator();
  await refreshQueueFromMain();

  // Nhận sự kiện tiến độ thời gian thực từ Main Process
  window.biliApi.onDownloadUpdate((job) => {
    const idx = state.jobs.findIndex((x) => x.jobId === job.jobId);
    if (idx >= 0) state.jobs[idx] = job;
    else state.jobs.unshift(job);
    updateQueueBadge();
    if ($('view-queue').classList.contains('active')) {
      renderQueue();
    }
  });

  // Navigation
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.onclick = () => switchView(btn.dataset.view);
  });
  $('sidebarCookieBtn').onclick = () => switchView('settings');

  $('themeToggleBtn').onclick = async () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyTheme(next);
    state.settings = await window.biliApi.updateSettings({ theme: next });
  };

  // Download view events
  $('analyzeBtn').onclick = () => handleAnalyze();
  $('urlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAnalyze();
  });
  $('pasteBtn').onclick = async () => {
    try {
      const txt = await navigator.clipboard.readText();
      if (txt) $('urlInput').value = txt;
    } catch {}
  };
  $('clearUrlBtn').onclick = () => {
    $('urlInput').value = '';
    $('analyzeErrorBox').classList.add('hidden');
  };
  $('copyCleanUrlBtn').onclick = () => {
    navigator.clipboard.writeText($('resCleanUrl').value || '');
    toast('Đã sao chép URL!', 'success');
  };
  $('toggleDescBtn').onclick = () => {
    const el = $('resDescText');
    const exp = el.classList.toggle('expanded');
    $('toggleDescBtn').textContent = exp ? 'Thu gọn' : 'Xem thêm';
  };

  document.querySelectorAll('#downloadModeGroup .seg-btn').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#downloadModeGroup .seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.selectedMode = btn.dataset.mode;
      renderQualityOptions();
      updateOutputOptionsUI();
    };
  });

  $('chooseTaskFolderBtn').onclick = async () => {
    const dir = await window.biliApi.chooseFolder();
    if (dir) {
      state.customSaveDir = dir;
      $('taskSaveDirInput').value = dir;
    }
  };
  $('startDownloadBtn').onclick = handleStartDownload;
  $('exportMetaBtn').onclick = () => {
    if (!state.analysis) return;
    const blob = new Blob([JSON.stringify(state.analysis.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.analysis.data.bvid || 'bilibili'}_metadata.json`;
    a.click();
    toast('Đã xuất Metadata JSON!', 'success');
  };

  $('selectAllPartsBtn').onclick = () => {
    const chks = Array.from(document.querySelectorAll('#partsList .part-chk'));
    const allChecked = chks.length > 0 && chks.every((c) => c.checked);
    chks.forEach((c) => (c.checked = !allChecked));
  };
  $('enqueueSelectedPartsBtn').onclick = handleEnqueueSelectedParts;

  // Queue events
  $('openDownloadDirBtn').onclick = () => window.biliApi.openPath(state.settings.downloadDir);
  $('clearFinishedJobsBtn').onclick = async () => {
    for (const j of state.jobs) {
      if (['completed', 'cancelled', 'failed'].includes(j.status)) {
        await window.biliApi.removeDownload(j.jobId);
      }
    }
    await refreshQueueFromMain();
  };

  // Space events
  $('scanSpaceBtn').onclick = () => handleScanSpace(1);
  $('spaceInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleScanSpace(1);
  });
  $('spacePrevBtn').onclick = () => {
    if (state.spaceState.page > 1) handleScanSpace(state.spaceState.page - 1);
  };
  $('spaceNextBtn').onclick = () => handleScanSpace(state.spaceState.page + 1);
  $('spaceSelectAllBtn').onclick = () => {
    const chks = Array.from(document.querySelectorAll('#spaceVideosGrid .space-check'));
    const all = chks.length > 0 && chks.every((c) => c.checked);
    chks.forEach((c) => (c.checked = !all));
  };
  $('spaceEnqueueBtn').onclick = handleEnqueueSpaceSelected;

  // History events
  $('historySearchInput').oninput = renderHistory;
  $('clearHistoryBtn').onclick = async () => {
    await window.biliApi.clearHistory();
    await loadHistory();
    toast('Đã xóa toàn bộ lịch sử.', 'info');
  };

  // Settings events
  $('setBrowseDirBtn').onclick = async () => {
    const dir = await window.biliApi.chooseFolder();
    if (dir) $('setDownloadDir').value = dir;
  };
  $('saveSettingsBtn').onclick = async () => {
    const patch = {
      downloadDir: $('setDownloadDir').value,
      maxConcurrent: Number($('setMaxConcurrent').value),
      theme: $('setTheme').value,
      saveMetadataJson: $('setSaveMetadata').checked
    };
    state.settings = await window.biliApi.updateSettings(patch);
    applyTheme(state.settings.theme);
    toast('Đã lưu cài đặt!', 'success');
  };

  $('saveCookieBtn').onclick = async () => {
    try {
      const raw = $('cookieTextarea').value;
      state.cookieStatus = await window.biliApi.saveCookie(raw);
      $('cookieTextarea').value = '';
      updateCookieIndicator();
      toast(state.cookieStatus.message, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  $('clearCookieBtn').onclick = async () => {
    state.cookieStatus = await window.biliApi.clearCookie();
    $('cookieTextarea').value = '';
    updateCookieIndicator();
    toast('Đã xóa Cookie an toàn.', 'info');
  };
  $('refreshLogsBtn').onclick = async () => {
    const logs = await window.biliApi.getRecentLogs();
    $('logsBox').textContent = logs.join('\n') || '(Chưa có log)';
  };
}

document.addEventListener('DOMContentLoaded', bootstrap);
