const SETTINGS_KEY = "settings";
const DEFAULT_SETTINGS = {
  directoryId: "",
  quality: "320",
};
const QUALITY_OPTIONS = [
  { label: "标准 128k", value: "128" },
  { label: "较高 320k", value: "320" },
  { label: "无损 FLAC", value: "flac" },
  { label: "Hi-Res", value: "high" },
];
const QUALITY_CHAIN = {
  128: ["128"],
  320: ["320", "128"],
  flac: ["flac", "320", "128"],
  high: ["high", "flac", "320", "128"],
};

const formatBytes = (bytes) => {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const formatSpeed = (bytesPerSecond) => {
  const value = Number(bytesPerSecond) || 0;
  if (value <= 0) return "";
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB/s`;
  return `${(value / 1024 / 1024).toFixed(1)} MB/s`;
};

const matchesQuality = (goods, quality) => {
  const name = String(goods?.quality ?? "").trim().toLowerCase();
  const level = Number(goods?.level) || 0;
  if (quality === "128") return name === "128" || level === 1 || level === 2;
  if (quality === "320") return name === "320" || name === "hq" || level === 4;
  if (quality === "flac") return name === "flac" || name === "sq" || level === 5;
  if (quality === "high") {
    return ["high", "hires", "hi-res", "res"].includes(name) || level === 6;
  }
  return name === quality;
};

const appendUrl = (urls, value) => {
  if (typeof value === "string") {
    const url = value.trim();
    if (url && !urls.includes(url)) urls.push(url);
    return;
  }
  if (Array.isArray(value)) value.forEach((item) => appendUrl(urls, item));
};

// 与主程序一致：兼容 url / play_url / backup_url 以及 data、info 包装。
const extractUrls = (payload) => {
  if (!payload) return [];
  if (typeof payload === "string") return payload.trim() ? [payload.trim()] : [];
  if (Array.isArray(payload)) {
    const urls = [];
    appendUrl(urls, payload);
    return urls;
  }
  if (typeof payload === "object") {
    const record = payload;
    const urls = [];
    ["url", "play_url", "playUrl", "backupUrl", "backup_url", "backupUrls"].forEach((key) =>
      appendUrl(urls, record[key]),
    );
    if (urls.length) return urls;
    if ("data" in record) return extractUrls(record.data);
    if ("info" in record) return extractUrls(record.info);
  }
  return [];
};

const sanitizeName = (value) =>
  String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 120);

// 酷狗部分歌曲的 title 已带「歌手 - 」前缀，避免文件名重复出现歌手。
const stripArtistPrefix = (value, artist) => {
  const title = String(value || "").trim();
  const name = String(artist || "").trim();
  if (!title || !name || title.length <= name.length) return title;
  if (title.slice(0, name.length).toLowerCase() !== name.toLowerCase()) return title;
  const rest = title.slice(name.length);
  const matched = rest.match(/^\s*[-–—]\s*/);
  if (!matched) return title;
  return rest.slice(matched[0].length).trim() || title;
};

const guessExtension = (url, quality) => {
  try {
    const pathname = new URL(url).pathname;
    const matched = pathname.match(/\.(mp3|flac|m4a|aac|ogg|opus|wav|ape)$/i);
    if (matched) return matched[1].toLowerCase();
  } catch {
    // 地址不是标准 URL 时退回按音质推断。
  }
  return quality === "flac" || quality === "high" ? "flac" : "mp3";
};

const buildFileName = (song, url, quality) => {
  const artist = sanitizeName(song.artist);
  const title =
    sanitizeName(stripArtistPrefix(song.title, song.artist)) ||
    sanitizeName(stripArtistPrefix(song.name, song.artist)) ||
    "未命名歌曲";
  const base = sanitizeName(artist ? `${artist} - ${title}` : title) || "未命名歌曲";
  const safeBase = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base) ? `_${base}` : base;
  return `${safeBase}.${guessExtension(url, quality)}`;
};

export function activate(ctx) {
  let settings = { ...DEFAULT_SETTINGS };
  const active = new Set();
  const handles = new Map();

  const settingsReady = ctx.storage
    .get(SETTINGS_KEY)
    .then((saved) => {
      if (saved && typeof saved === "object") {
        settings = {
          ...DEFAULT_SETTINGS,
          ...saved,
          quality: QUALITY_CHAIN[saved.quality] ? saved.quality : DEFAULT_SETTINGS.quality,
        };
      }
    })
    .catch(() => {});

  const saveSettings = async (patch = {}) => {
    settings = { ...settings, ...patch };
    await ctx.storage.set(SETTINGS_KEY, settings).catch(() => {});
  };

  const currentTrack = () => {
    const track = ctx.player?.currentTrack;
    return track && "value" in track ? track.value : track;
  };

  const findGrant = async () => {
    if (!settings.directoryId) return null;
    const grants = await ctx.fs.listDirectoryGrants();
    return (
      grants.find(
        (grant) =>
          grant.id === settings.directoryId &&
          grant.kind === "user" &&
          grant.access === "read-write" &&
          grant.available,
      ) || null
    );
  };

  const ensureDirectory = async () => {
    const existing = await findGrant();
    if (existing) return existing;
    const selection = await ctx.fs.requestDirectory({
      access: "read-write",
      purpose: "保存下载的音乐文件",
      persist: true,
    });
    if (!selection.ok) {
      throw new Error(selection.error?.message || "无法获取目录授权");
    }
    if (selection.canceled) return null;
    await saveSettings({ directoryId: selection.directory.id });
    return selection.directory;
  };

  const resolveAudioUrl = async (song, preferredQuality, signal) => {
    const chain = QUALITY_CHAIN[preferredQuality] || QUALITY_CHAIN["320"];
    const relateGoods = Array.isArray(song.relateGoods) ? song.relateGoods : [];
    const options = {
      albumId: song.albumId,
      albumAudioId: song.albumAudioId || song.mixSongId,
    };
    const attempts = [];
    chain.forEach((quality) => {
      const matched = relateGoods.find((item) => item?.hash && matchesQuality(item, quality));
      if (matched) attempts.push([matched.hash, quality]);
    });
    chain.forEach((quality) => attempts.push([song.hash, quality]));
    attempts.push([song.hash, ""]);

    const seen = new Set();
    let lastError = null;
    for (const [hash, quality] of attempts) {
      const key = `${hash}|${quality}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (signal?.aborted) {
        throw Object.assign(new Error("已取消"), { name: "AbortError" });
      }
      try {
        const response = await ctx.kugou.music.getSongUrl(hash, quality, undefined, options);
        const urls = extractUrls(response);
        if (urls.length) return urls[0];
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      lastError?.message || "无法获取下载地址，可能受版权或会员权限限制",
    );
  };

  async function downloadSong(song, options = {}) {
    const silent = options.silent === true;
    await settingsReady;
    if (!song || !song.hash) {
      if (!silent) ctx.toast.warning("这首歌缺少可下载的音源信息");
      return { status: "skipped", reason: "missing" };
    }
    const key = String(song.hash);
    if (active.has(key)) {
      if (!silent) ctx.toast.info("这首歌正在下载中");
      return { status: "skipped", reason: "active" };
    }

    let directory = null;
    try {
      directory = await ensureDirectory();
    } catch (error) {
      if (!silent) ctx.toast.danger(error?.message || "选择保存目录失败");
      return { status: "error", error: error?.message || "选择保存目录失败" };
    }
    if (!directory) return { status: "skipped", reason: "canceled" };

    active.add(key);
    const title =
      stripArtistPrefix(song.title, song.artist) ||
      stripArtistPrefix(song.name, song.artist) ||
      "未命名歌曲";
    let task = null;
    let settled = false;
    task = ctx.tasks.register({
      id: `${ctx.id}:download:${key}`,
      name: `下载 ${title}`,
      status: "running",
      retention: "transient",
      progress: { label: "准备中" },
      actions: [
        {
          id: "cancel",
          label: "取消",
          variant: "ghost",
          async onClick() {
            const handle = handles.get(key);
            if (handle) await handle.cancel().catch(() => {});
            task?.cancel();
          },
        },
      ],
    });

    let unsubscribe = null;
    try {
      const url = await resolveAudioUrl(song, settings.quality, task.signal);
      if (task.signal.aborted) throw Object.assign(new Error("已取消"), { name: "AbortError" });

      const fileName = buildFileName(song, url, settings.quality);
      const file = {
        kind: "directory-file",
        directoryId: directory.id,
        relativePath: fileName,
      };
      const existing = await ctx.fs.stat(file).catch(() => null);
      if (existing && !existing.directory) {
        settled = true;
        task.finish("completed", { progress: { label: "文件已存在，跳过下载" } });
        if (!silent) ctx.toast.info(`已存在：${fileName}`);
        return { status: "skipped", reason: "exists" };
      }

      task.update({ progress: { label: "连接中" } });
      const handle = await ctx.net.download({
        url,
        headers: {
          "User-Agent": navigator.userAgent,
        },
        target: { directoryId: directory.id, relativePath: fileName },
        name: [sanitizeName(song.artist), title].filter(Boolean).join(" - ") || title,
        sourceKey: `echo-music/song/${key}`,
        conflict: "rename",
        maxBytes: 1024 * 1024 * 1024,
      });
      handles.set(key, handle);

      unsubscribe = handle.subscribe((snapshot) => {
        if (settled) return;
        const received = formatBytes(snapshot.receivedBytes);
        const speed = formatSpeed(snapshot.bytesPerSecond);
        if (snapshot.totalBytes) {
          task.update({
            progress: {
              done: snapshot.receivedBytes,
              total: snapshot.totalBytes,
              label: `${received} / ${formatBytes(snapshot.totalBytes)}${speed ? ` · ${speed}` : ""}`,
            },
          });
        } else {
          task.update({ progress: { label: `${received}${speed ? ` · ${speed}` : ""}` } });
        }
      });

      await handle.wait({ signal: task.signal });
      settled = true;
      task.finish("completed", { progress: { label: "下载完成" } });
      if (!silent) ctx.toast.success(`已下载：${fileName}`);
      return { status: "done", fileName };
    } catch (error) {
      if (settled) return { status: "skipped", reason: "settled" };
      settled = true;
      if (task.signal.aborted || error?.name === "AbortError") {
        task.finish("aborted", { progress: { label: "已取消" } });
        if (!silent) ctx.toast.info("已取消下载");
        return { status: "aborted" };
      }
      task.finish("error", { error: error?.message || String(error) });
      if (!silent) ctx.toast.danger(`下载失败：${error?.message || error}`);
      return { status: "error", error: error?.message || String(error) };
    } finally {
      unsubscribe?.();
      handles.delete(key);
      active.delete(key);
    }
  }

  const { defineComponent, defineAsyncComponent, h, ref, computed, watch, onMounted } = ctx.vue;
  const Button = defineAsyncComponent(ctx.ui.components.Button);
  const Select = defineAsyncComponent(ctx.ui.components.Select);

  const Settings = defineComponent({
    name: "MusicDownloaderSettings",
    setup() {
      const quality = ref(settings.quality);
      const displayPath = ref("读取中…");
      const busy = ref(false);

      const refreshPath = async () => {
        try {
          const grant = await findGrant();
          displayPath.value = grant
            ? grant.displayPath || grant.name
            : "未选择（首次下载时会提示选择）";
        } catch {
          displayPath.value = "未选择";
        }
      };

      onMounted(refreshPath);

      const chooseDirectory = async () => {
        if (busy.value) return;
        busy.value = true;
        try {
          const selection = await ctx.fs.requestDirectory({
            access: "read-write",
            purpose: "保存下载的音乐文件",
            persist: true,
          });
          if (!selection.ok) throw new Error(selection.error?.message || "选择目录失败");
          if (selection.canceled) return;
          await saveSettings({ directoryId: selection.directory.id });
          await refreshPath();
          ctx.toast.success("保存位置已更新");
        } catch (error) {
          ctx.toast.danger(error?.message || "选择目录失败");
        } finally {
          busy.value = false;
        }
      };

      const changeQuality = async (value) => {
        quality.value = value;
        await saveSettings({ quality: value });
      };

      const row = (label, control, hint) =>
        h("div", { style: "display: grid; gap: 6px;" }, [
          h("div", { style: "font-size: 13px; font-weight: 600;" }, label),
          control,
          hint
            ? h(
                "div",
                { style: "font-size: 11px; opacity: .6; line-height: 1.5;" },
                hint,
              )
            : null,
        ]);

      return () =>
        h("div", { style: "display: grid; gap: 18px; padding: 4px 0;" }, [
          row(
            "保存位置",
            h("div", { style: "display: flex; align-items: center; gap: 8px;" }, [
              h(
                "div",
                {
                  style:
                    "flex: 1; min-width: 0; padding: 7px 10px; border: 1px solid var(--border-subtle, rgba(127,127,127,.25)); border-radius: 8px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;",
                  title: displayPath.value,
                },
                displayPath.value,
              ),
              h(
                Button,
                { size: "xs", disabled: busy.value, onClick: chooseDirectory },
                { default: () => "选择文件夹" },
              ),
            ]),
            "文件会直接保存到所选文件夹，同名文件自动重命名，不会覆盖。",
          ),
          row(
            "下载音质",
            // 包一层 flex：Select 的弹层触发器 span 若直接作为 grid 项会被拉伸到整行宽度，
            // 导致下拉面板按整行右边界对齐而错位。
            h("div", { style: "display: flex; justify-content: flex-start;" }, [
              h(Select, {
                modelValue: quality.value,
                options: QUALITY_OPTIONS,
                "onUpdate:modelValue": changeQuality,
              }),
            ]),
            "优先使用所选音质，资源不可用时自动回退到较低音质。",
          ),
          h(
            "div",
            {
              style:
                "font-size: 11px; opacity: .55; line-height: 1.6; border-top: 1px solid var(--border-subtle, rgba(127,127,127,.2)); padding-top: 10px;",
            },
            "下载使用当前账号的播放权限；VIP、数字专辑或版权受限的歌曲可能无法下载。请在入口处右键歌曲选择「下载到本地」，或点击播放栏的下载按钮下载当前歌曲。",
          ),
        ]);
    },
  });

  ctx.ui.settings.define({
    title: "音乐下载器",
    description: "把歌曲下载到本地文件夹，支持音质选择与任务进度。",
    component: Settings,
  });

  // 批量下载：宿主未给「批量操作」抽屉提供插件扩展点，改为在播放队列上提供批量下载页。
  const queueSongKey = (song) =>
    String(song?.hash || song?.mixSongId || song?.id || song?.name || "");

  const readQueueSongs = () => {
    try {
      const active = ctx.playlist?.activeQueue;
      const current =
        active && "value" in active ? active.value : ctx.playlist?.getActiveQueue?.();
      const list = current?.songs ?? ctx.playlist?.getQueueSongs?.();
      return Array.isArray(list) ? list.slice() : [];
    } catch {
      return [];
    }
  };

  const BatchPage = defineComponent({
    name: "MusicDownloaderBatchPage",
    setup() {
      const songs = computed(readQueueSongs);
      const selected = ref(new Set());
      const busy = ref(false);
      const progress = ref("");

      // 播放队列变化时清理已不存在的选中项。
      watch(songs, (list) => {
        const valid = new Set(list.filter((song) => song?.hash).map(queueSongKey));
        const next = new Set([...selected.value].filter((key) => valid.has(key)));
        if (next.size !== selected.value.size) selected.value = next;
      });

      const selectedCount = computed(() => selected.value.size);
      const downloadableSongs = computed(() => songs.value.filter((song) => song?.hash));
      const allSelected = computed(
        () =>
          downloadableSongs.value.length > 0 &&
          downloadableSongs.value.every((song) => selected.value.has(queueSongKey(song))),
      );

      const toggle = (key) => {
        if (!key) return;
        const next = new Set(selected.value);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        selected.value = next;
      };

      const toggleAll = () => {
        selected.value = allSelected.value
          ? new Set()
          : new Set(downloadableSongs.value.map(queueSongKey));
      };

      const runBatch = async () => {
        if (busy.value) return;
        const picked = downloadableSongs.value.filter((song) =>
          selected.value.has(queueSongKey(song)),
        );
        if (!picked.length) {
          ctx.toast.info("请先勾选要下载的歌曲");
          return;
        }
        busy.value = true;
        progress.value = `0/${picked.length}`;
        let cursor = 0;
        let done = 0;
        let failed = 0;
        let skipped = 0;
        // 两个并发，其余由宿主的下载引擎排队。
        const worker = async () => {
          while (cursor < picked.length) {
            const song = picked[cursor];
            cursor += 1;
            const result = await downloadSong(song, { silent: true });
            if (result?.status === "done") done += 1;
            else if (result?.status === "error") failed += 1;
            else skipped += 1;
            progress.value = `${done + failed + skipped}/${picked.length}`;
          }
        };
        try {
          await Promise.all([worker(), worker()]);
        } finally {
          busy.value = false;
          progress.value = "";
        }
        if (failed) {
          ctx.toast.warning(
            `批量下载结束：成功 ${done} 首，失败 ${failed} 首，跳过 ${skipped} 首`,
          );
        } else {
          ctx.toast.success(
            `批量下载完成：成功 ${done} 首${skipped ? `，跳过 ${skipped} 首` : ""}`,
          );
        }
      };

      const ACCENT = "var(--color-primary, #00cc88)";

      // 自绘勾选框：原生 input 在本主题下会被重置成看不见的样式。
      const checkbox = (checked, onToggle, disabled) =>
        h(
          "span",
          {
            role: "checkbox",
            "aria-checked": checked,
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!disabled) onToggle();
            },
            style: [
              "width: 19px",
              "height: 19px",
              "flex-shrink: 0",
              "border-radius: 6px",
              "display: flex",
              "align-items: center",
              "justify-content: center",
              "font-size: 13px",
              "font-weight: 700",
              "line-height: 1",
              "color: #fff",
              "transition: background .15s ease, border-color .15s ease",
              `border: 1.5px solid ${checked ? ACCENT : "rgba(127,127,127,.55)"}`,
              `background: ${checked ? ACCENT : "transparent"}`,
              `opacity: ${disabled ? 0.4 : 1}`,
              `cursor: ${disabled ? "not-allowed" : "pointer"}`,
            ].join(";"),
          },
          checked ? "✓" : "",
        );

      return () =>
        h(
          "div",
          {
            style:
              "display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; box-sizing: border-box;",
          },
          [
            h(
              "div",
              {
                style:
                  "display: flex; align-items: center; gap: 12px; flex-shrink: 0; padding: 9px 12px; border-radius: 10px; background: rgba(127,127,127,.12); border: 1px solid rgba(127,127,127,.16);",
              },
              [
                h(
                  "span",
                  {
                    onClick: () => {
                      if (!busy.value && downloadableSongs.value.length) toggleAll();
                    },
                    style: `display: inline-flex; align-items: center; gap: 9px; font-size: 13px; font-weight: 600; cursor: ${busy.value || !downloadableSongs.value.length ? "not-allowed" : "pointer"};`,
                  },
                  [
                    checkbox(
                      allSelected.value,
                      toggleAll,
                      busy.value || !downloadableSongs.value.length,
                    ),
                    "全选",
                  ],
                ),
                h(
                  "span",
                  {
                    style:
                      "font-size: 12px; opacity: .75; font-variant-numeric: tabular-nums;",
                  },
                  [
                    "已选 ",
                    h(
                      "b",
                      { style: `font-size: 13px; color: ${ACCENT};` },
                      String(selectedCount.value),
                    ),
                    ` / ${songs.value.length} 首`,
                  ],
                ),
                busy.value
                  ? h(
                      "span",
                      { style: `font-size: 12px; color: ${ACCENT}; opacity: .9;` },
                      `下载中 ${progress.value}`,
                    )
                  : null,
                h(
                  "div",
                  { style: "margin-left: auto; display: flex; gap: 8px;" },
                  [
                    h(
                      Button,
                      {
                        size: "sm",
                        variant: "solid-primary",
                        disabled: busy.value || !selectedCount.value,
                        onClick: runBatch,
                      },
                      { default: () => (busy.value ? "下载中…" : "下载选中") },
                    ),
                  ],
                ),
              ],
            ),
            songs.value.length
              ? h(
                  "div",
                  {
                    style:
                      "flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 5px; padding-right: 4px;",
                  },
                  songs.value.map((song, index) => {
                    const key = queueSongKey(song);
                    const downloadable = !!song?.hash;
                    const picked = downloadable && selected.value.has(key);
                    const title =
                      stripArtistPrefix(song.title, song.artist) ||
                      stripArtistPrefix(song.name, song.artist) ||
                      "未命名歌曲";
                    return h(
                      "div",
                      {
                        onClick: () => {
                          if (!busy.value && downloadable) toggle(key);
                        },
                        style: [
                          "display: flex",
                          "align-items: center",
                          "gap: 12px",
                          "padding: 9px 12px",
                          "border-radius: 10px",
                          "transition: background .12s ease",
                          `background: ${picked ? `color-mix(in srgb, ${ACCENT} 20%, transparent)` : "rgba(127,127,127,.07)"}`,
                          `border: 1px solid ${picked ? ACCENT : "transparent"}`,
                          `box-shadow: ${picked ? `inset 3px 0 0 ${ACCENT}` : "none"}`,
                          `opacity: ${downloadable ? 1 : 0.42}`,
                          `cursor: ${downloadable && !busy.value ? "pointer" : "default"}`,
                        ].join(";"),
                      },
                      [
                        checkbox(picked, () => toggle(key), busy.value || !downloadable),
                        h(
                          "span",
                          {
                            style:
                              "font-size: 12px; opacity: .5; width: 24px; flex-shrink: 0; font-variant-numeric: tabular-nums; text-align: right;",
                          },
                          String(index + 1),
                        ),
                        h(
                          "div",
                          {
                            style:
                              "min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px;",
                          },
                          [
                            h(
                              "div",
                              {
                                style:
                                  "font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;",
                              },
                              title,
                            ),
                            h(
                              "div",
                              {
                                style:
                                  "font-size: 12px; opacity: .7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;",
                              },
                              sanitizeName(song.artist) || "未知歌手",
                            ),
                          ],
                        ),
                        downloadable
                          ? null
                          : h(
                              "span",
                              {
                                style:
                                  "font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(127,127,127,.2); flex-shrink: 0;",
                              },
                              "无音源",
                            ),
                      ],
                    );
                  }),
                )
              : h(
                  "div",
                  {
                    style:
                      "flex: 1; display: flex; align-items: center; justify-content: center; font-size: 13px; opacity: .55;",
                  },
                  "播放队列为空，先播放一些歌曲再回来批量下载。",
                ),
          ],
        );
    },
  });

  ctx.ui.addPage({
    id: "batch-download",
    title: "批量下载",
    icon: "tabler:download",
    component: BatchPage,
    sidebar: { title: "批量下载", icon: "tabler:download" },
  });

  ctx.ui.addSongContextMenuItem({
    id: "download-song",
    label: "下载到本地",
    order: 60,
    visible: (song) => !!song?.hash,
    enabled: (song) => !!song?.hash,
    onSelect: (song) => downloadSong(song),
  });

  ctx.ui.playerbar.register({
    id: "download-current",
    title: "下载当前歌曲",
    icon: "tabler:download",
    tooltip: "下载当前播放的歌曲",
    defaultPlacement: "more",
    order: 120,
    disabled: () => !currentTrack()?.hash,
    onClick: () => downloadSong(currentTrack()),
  });

  // 播放栏上的显眼入口：打开批量下载页（宿主未开放队列抽屉的插件扩展点）。
  ctx.ui.playerbar.register({
    id: "open-batch-download",
    title: "批量下载",
    icon: "tabler:download",
    tooltip: "批量下载播放队列里的歌曲",
    defaultPlacement: "right",
    order: 110,
    onClick: () => {
      const path = `/main/plugin/${encodeURIComponent(ctx.id)}/${encodeURIComponent("batch-download")}`;
      try {
        const result = ctx.router?.push?.(path);
        result?.catch?.(() => undefined);
      } catch {
        ctx.toast.info("请从左侧边栏打开「批量下载」");
      }
    },
  });
}
